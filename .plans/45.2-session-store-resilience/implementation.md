# 45.2 session-store-resilience - Implementation Plan

The session-store is the whole-app single point of failure: a slow synchronous query blocks
its single-threaded event loop, `:17424` goes to HTTP 000, and every session goes dark until
someone notices and restarts it. Plan 45.1 made the *known* hot path (the `/sessions`
inventory poll) cheap, but left three gaps that let the failure recur silently on
2026-07-06 (a merged-but-unapplied index fix ran on a stale store process for 15h). This plan
closes all three: make store health **visible** (drift doctor), make a wedge **self-heal**
(watchdog), and make a single query **bounded** so it cannot pin the loop (in-thread circuit
breaker).

## 0. Hard Dependencies

None blocking - every foundation this builds on is already merged. It is additive to:

- <!-- D-005 --> **Plan 45.1** (completed): the frozen `SessionLog.query()` instrumentation
  seam (`apps/session-store/src/log.ts:146`), the `queries` counter, the
  `trevor.store.slow_query` span, the `events_session_type_seq` index, and **D-007 (stay
  synchronous - no worker thread)**, which M3 must not violate.
- **Plan 41** (completed): the frozen 14-area `DoctorSnapshot` contract
  (`packages/session/src/doctor.ts`) and its host builder / web renderer. M1 extends the
  existing `storage` area rather than adding a 15th area.
- **Plan 44.1** (completed): the `@trevor/launcher` + supervisor (`apps/supervisor/`,
  `packages/launcher/src/platform.ts`). M2 extends the supervisor.

---

## Architecture

### The failure being prevented

The store runs `node:sqlite` **synchronously** on a single event-loop thread (45.1 D-007).
Any query that does real work (a reverse b-tree scan over a large `events` slice) blocks
`/health`, the SSE streams, and every POST for the query's whole duration - HTTP 000 at 90%
CPU. Three independent things failed on 2026-07-06:

1. **Invisible:** the store ran code from *before* the `events_session_type_seq` index commit,
   so its hot lookups fell back to PK-only scans - and nothing surfaced that the running store
   was stale or that its query plan had degraded.
2. **Unrecoverable:** launchdawg's `KeepAlive` only respawns on process *death*; a live
   busy-loop wedge (process alive, socket held) is invisible to it, so the wedge persisted for
   hours.
3. **Unbounded:** a single query can run arbitrarily long on the shared thread; the 45.1 M3
   guardrail *observes* a slow query (a `slow_query` span past 100ms) but does not *stop* it.

### The three layers (defense in depth)

<!-- D-004 -->
**M1 - Drift doctor (visibility).** The store gains a self-check exposed on a new store route
`GET /diag`: `indexHealthy` (runs `EXPLAIN QUERY PLAN` on the hot inventory lookup and asserts
it `SEARCH ... USING ... INDEX events_session_type_seq` with no `SCAN`/`TEMP B-TREE`), a schema
`user_version`, the git SHA captured at store startup, and the existing `queries` /
slow-query counts. The host doctor's existing frozen **`storage`** area probes `/diag` and
folds the result in as facts/findings, so a degraded plan or stale store surfaces in the same
`/doctor` the operator already reads. `indexHealthy=false` reproduces today's exact bug as a
one-line finding; the SHA/`user_version` are secondary "running stale code / schema behind"
hints.

<!-- D-003 -->
**M2 - Watchdog (recovery).** The supervisor (already a long-running local service on
`:17425`) gains a watchdog loop: poll the store `/health` with a short timeout on an interval;
after **N consecutive** failures over a window (a booting store is protected by a startup
grace), **terminate the wedged store PID** and let launchdawg `KeepAlive` respawn it (~2s).
Guards: exponential backoff + an attempt cap with an alarm span so it never kill-loops. Kill +
respawn (not `startService`) avoids the duplicate-`:17424`-bind hazard; kill (not `launchdawg
restart`) couples to no external CLI. This converts a multi-hour silent wedge into a ~10s blip,
cause-agnostic.

<!-- D-002 -->
**M3 - Circuit breaker (bounding).** In the `SessionLog.query()` seam: (a) a per-statement
`vdbeOp` opcode ceiling (gated on spike **A-001**) so a single statement that would scan far
past a legit indexed lookup aborts with a typed error instead of running to completion; and
(b) a post-slow-query breaker - when a query exceeds the budget the breaker opens and
subsequent queries fast-fail (typed "store overloaded" error the server maps to 503) for a
cooldown, then half-open probes and closes. This stays **synchronous** (respects 45.1 D-007);
it does not truly abort a query already mid-flight without a worker thread, so the watchdog
(M2) remains the backstop for that residual. Writes check the breaker **before** any mutation
so a trip never corrupts the in-memory read model or the gap-free `MAX(seq)+1` seq invariant.

### Key Constraints

| Constraint | Impact |
|---|---|
| 45.1 D-007: `node:sqlite` stays synchronous (gap-free `MAX(seq)+1` write invariant) | M3 must be in-thread and bounded, not a worker-thread mid-flight abort. |
| Doctor contract is frozen (plan 41, 14 areas, host/web parity test) | M1 extends the existing `storage` area; no new area, no contract bump. |
| The doctor runs in the agent-host; the store is a separate `:17424` service | M1 needs a host to store probe (`GET /diag`); the host doctor cannot introspect the store's DB directly. |
| launchdawg `KeepAlive` respawns on death only, not on a live wedge | M2 must detect the wedge and force death; kill + respawn avoids dup-port-bind. |
| `/health` is shared server-kit infra returning `{ ok: true }` (the launcher prober asserts `isHealthBody`) | Keep `/health` as the fast liveness probe; put the richer self-check on a separate store `/diag` route so `/health` stays cheap and its guard intact. |
| No git SHA exists at runtime today | M1 captures `git rev-parse HEAD` at store startup (reuse the `git-status.ts` argv runner); "built SHA" for a from-source `tsx` store is HEAD-at-startup. |

### Boundaries

- `apps/session-store/src/log.ts` - owns the M1 self-check (`SessionLog.diag()`:
  `indexHealthy` via `explainTypeLookup()`, `user_version`, startup SHA) and the M3 breaker +
  `vdbeOp` policy inside the existing `query()` seam.
- `apps/session-store/src/server.ts` - adds `GET /diag` returning the `diag()` payload.
- `apps/agent-host/src/doctor/areas-platform.ts` - the `storage` area gains a host to store
  `/diag` probe and folds store health into its facts/findings.
- `apps/supervisor/src/main.ts` (+ a new `apps/supervisor/src/watchdog.ts`) - owns the M2
  poll-and-recover loop; reuses `fetchWithTimeout` / `waitForStore` and a "find + terminate
  the store PID" helper.
- No change to the `/sessions` REST or stream wire contract; no worker thread; no new doctor
  area.

### Observability

This plan is itself observability + recovery work; it extends the `trevor.store.*` span
family (45.1) and emits structured events for every automated action:

- `trevor.store.diag` - the self-check result (indexHealthy, user_version, sha), so a degraded
  plan is queryable, not just rendered.
- `trevor.supervisor.store_wedge_detected` / `trevor.supervisor.store_restarted` - the
  watchdog's detection and each kill+respawn, with the failure streak and recovery latency.
- `trevor.supervisor.store_recovery_exhausted` - the alarm span when backoff hits the cap.
- `trevor.store.circuit_open` / `trevor.store.circuit_closed` - breaker transitions, with the
  triggering query name and open duration.
- The doctor `storage` finding is the user-visible inspection surface for all of the above.

---

## Assumptions

| Code | Assumption | Status | Impact if False |
|------|-----------|--------|-----------------|
| A-001 | Node 24.15 `node:sqlite` supports a per-statement `vdbeOp` opcode-count limit that aborts an over-budget statement (settable at construction and/or via `limits.vdbeOp`). | untested | M3's per-statement hard cap is dropped; the breaker falls back to post-slow-query cooldown only, and the watchdog (M2) is the sole guarantee against a single query pinning the loop. Does not block M1/M2. |

Spiked as the first task of M3 (a tiny `vdbeOp` cap on a temp `DatabaseSync`, run a scan, assert
it throws). If it fails, M3 proceeds with the breaker-only fallback and records the outcome.

---

## Phases

### Phase 1: Store resilience (visibility -> recovery -> bounding)

**Goal:** a wedge is visible in `/doctor`, self-heals in ~10s, and no single query can run
unbounded on the store thread.

**Gate from previous:** none.

#### M1: Drift doctor (store self-check + host doctor surface)

- **Dependencies:** none
- **Effort:** M (3-7d)
- **Tasks:**
  1. RED: Failing test that `SessionLog.diag()` reports `indexHealthy=false` when
     `events_session_type_seq` is absent and `true` when present (temp-DB fixture that
     drops/creates the index), and that it carries `schemaVersion` (`user_version`) and a
     captured startup SHA.
  2. GREEN: Implement `SessionLog.diag()` - `indexHealthy` via the existing
     `explainTypeLookup()`, read `PRAGMA user_version`, capture `git rev-parse HEAD` at store
     startup (reuse the `git-status.ts` argv runner), include `queries` + slow-query counts.
  3. RED: Failing test that `GET /diag` returns the `diag()` payload (route-level test).
  4. GREEN: Add the `GET /diag` route to `server.ts` (leave `/health` as the bare fast probe).
  5. RED: Failing test that the host doctor `storage` area emits a store-drift **finding**
     when the probed `/diag` reports `indexHealthy=false` (or store SHA != host HEAD), and a
     clean fact when healthy (mock the store `/diag` response).
  6. GREEN: Add a host to store `/diag` probe in `storageArea()` and fold the result into its
     facts/findings; emit the `trevor.store.diag` span.
  7. RED: Failing test that schema `user_version` is stamped at startup and bumped through a
     tiny migration constant (so schema drift is detectable).
  8. GREEN: Add the `user_version` stamp/migration hook.
  9. REFACTOR: Consolidate the self-check into one `diag()` owner; confirm the doctor host/web
     parity test still passes; module comments on the new store `/diag` seam and the probe.

#### M2: Supervisor watchdog (detect wedge, kill + KeepAlive respawn)

- **Dependencies:** M1 (reuses `/health`; `/diag` optional signal)
- **Effort:** M (3-7d)
- **Tasks:**
  1. RED: Failing test that the watchdog trips after N consecutive `/health` failures over the
     window (injected fake `/health` returning 000/timeout) and calls the terminate action
     **exactly once** (not per poll).
  2. GREEN: Add `apps/supervisor/src/watchdog.ts` - an interval loop using `fetchWithTimeout`
     against the store `/health`; on sustained failure, find + terminate the store PID; emit
     `store_wedge_detected` / `store_restarted` spans. Wire it into `supervisor/main.ts:main()`.
  3. RED: Failing test for the startup/bootstrap grace - a booting store (health not yet up) is
     NOT killed until the grace elapses.
  4. GREEN: Implement the startup grace.
  5. RED: Failing test for the restart-storm guard - if the store fails to recover after a kill,
     the watchdog backs off exponentially, caps attempts, and emits `store_recovery_exhausted`
     instead of kill-looping.
  6. GREEN: Implement backoff + cap + alarm span; verify `/health` returns 200 within a grace
     before resuming normal polling.
  7. REFACTOR: Extract the "find the store PID" helper into the launcher platform; reuse
     `waitForStore`; module comment on the watchdog's supervision-not-communication boundary.

#### M3: Circuit breaker (in-thread bounded query budget)

- **Dependencies:** M1 (the `query()` seam), M2 (the backstop)
- **Effort:** M (3-7d)
- **Tasks:**
  1. SPIKE / RED (A-001): Characterize whether Node 24.15 supports a `vdbeOp` per-statement
     cap - set a tiny cap on a temp `DatabaseSync`, run a scan, assert it throws a typed limit
     error. Record the assumption outcome (`validate-assumption`).
  2. GREEN: If supported, set a per-statement `vdbeOp` ceiling sized so a legit indexed lookup
     passes but a large full scan aborts; surface the abort as a typed `StoreQueryBudgetError`
     from the `query()` seam. If unsupported, skip to task 3 (breaker-only) and note it.
  3. RED: Failing test that the post-slow-query breaker opens when a query exceeds the budget,
     fast-fails subsequent queries with a typed error for the cooldown, then half-open probes
     and closes.
  4. GREEN: Implement the breaker state machine in the `query()` seam; emit
     `trevor.store.circuit_open` / `circuit_closed`; map the typed error to HTTP 503 in
     `server.ts`.
  5. RED: Failing test that a tripped breaker on a write path throws **before** mutating, so
     the in-memory read model and the `MAX(seq)+1` seq invariant are never left half-applied.
  6. GREEN: Ensure the breaker/budget check precedes any mutation; graceful degradation on
     read paths (typed 503, no crash).
  7. REFACTOR: Fold the `vdbeOp` cap + breaker into one bounded-query policy composed with the
     existing `slow_query` span; update the `query()` seam comment; docs.

### Gate 1->done

- [ ] `pnpm test` (unit + web) passes, including the M1/M2/M3 tests.
- [ ] `pnpm typecheck` and `pnpm lint` clean.
- [ ] Doctor host/web parity test still passes (no contract drift).
- [ ] **Integrated repro:** simulate the 2026-07-06 wedge (drop the index / force a slow query)
      and confirm the three layers fire - the doctor `storage` area flags `indexHealthy=false`,
      the watchdog kills + respawns within its window, and the breaker aborts/short-circuits the
      over-budget query instead of pinning the loop.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Watchdog kills a store that is slow-but-recovering (false positive) -> churn | med | med | N-consecutive-failures over a window + startup grace + backoff/cap; tune thresholds against the observed ~15h wedge vs a legit multi-second startup scan | impl |
| A-001 false: no `vdbeOp` cap on Node 24 | med | med | Breaker-only fallback + watchdog backstop; documented, not a blocker | impl |
| Breaker trips on a legit slow-but-necessary query -> spurious 503s | med | low | Budget sized above the warmed indexed-lookup cost; half-open probe; the slow_query span makes tuning observable | impl |
| `/diag` probe adds host->store coupling / failure mode | low | low | Probe is best-effort with a short timeout; a `/diag` failure degrades to a doctor "unknown", never blocks the doctor | impl |
| Duplicate store on :17424 if kill + respawn races launchdawg | med | low | Kill only (never `startService`); verify single listener after respawn; the existing dup-bind guard | impl |

---

## Non-Goals

- **Event-log retention / compaction** (the 94k-event `trevor-local` slow burn) - stays deferred
  under 45.1 D-005 to its own future plan; 45.2 does not touch durable-event lifecycle.
- **Worker-thread / async SQLite** - explicitly excluded (45.1 D-007); M3 is in-thread bounded.
- **A new doctor area** - 45.2 extends the frozen `storage` area, it does not bump the contract.
- **Retiring the 4s `/sessions` poll** (45.1 D-008 future direction) - out of scope.

---

## Validation Commands

```bash
pnpm test:unit                          # session-store log/diag/breaker tests
pnpm test:web                           # doctor storage-area rendering
pnpm --filter @trevor/session-store test
pnpm --filter @trevor/supervisor test   # watchdog
pnpm typecheck
pnpm lint
```

---

## Decisions

Canonical decisions live in `.plans/45.2-session-store-resilience/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts \
  query-decisions --plan "45.2-session-store-resilience"
```

- <!-- D-001 --> Scope = drift doctor + watchdog + circuit breaker; retention OUT.
- <!-- D-002 --> Breaker = in-thread bounded (`vdbeOp` cap + cooldown), no worker thread; watchdog is the backstop.
- <!-- D-003 --> Watchdog = poll `/health`, kill wedged PID, launchdawg KeepAlive respawns; storm guards + startup grace.
- <!-- D-004 --> Drift = store `/diag` self-check (`indexHealthy` + `user_version` + startup SHA) surfaced in the doctor `storage` area.
- <!-- D-005 --> Order M1 -> M2 -> M3; numbered 45.2 off completed 45.1; builds on the frozen `query()` seam + `trevor.store.*` spans.
