# 45.2 session-store-resilience - Progress Report

**Stage:** ready

**Current focus:** Phase 1 · M1 - Drift doctor (first RED: `SessionLog.diag()` reports `indexHealthy=false` when the index is absent)

Close the three gaps that let the store-wedge failure recur silently on 2026-07-06: make store
health visible (drift doctor), make a wedge self-heal (watchdog), and bound a single query so it
cannot pin the single-threaded store loop (in-thread circuit breaker). Additive to plan 45.1;
retention stays out of scope.

## Summary

- **Milestones:** 3 (M1, M2, M3) - 0/3 complete
- **Tasks (current cutoff):** 0/23 checked
- **Assumptions:** 1 open (A-001: Node 24 `vdbeOp` per-statement cap - spiked in M3 task 1)
- **Deferred / follow-up:** none in-plan (event-log retention stays under 45.1 D-005, a separate future plan)
- **Superseded:** none

All work is current-cutoff.

---

## Phase 1: Store resilience (visibility -> recovery -> bounding)

### M1: Drift doctor (store self-check + host doctor surface) - 0/9

- [ ] RED: `SessionLog.diag()` reports `indexHealthy=false` when `events_session_type_seq` is
      absent, `true` when present (temp-DB fixture drops/creates it); carries `schemaVersion`
      + captured startup SHA. Fails today.
- [ ] GREEN: implement `diag()` - `indexHealthy` via `explainTypeLookup()`, read `PRAGMA
      user_version`, capture `git rev-parse HEAD` at startup (reuse `git-status.ts` runner),
      include `queries` + slow-query counts.
- [ ] RED: `GET /diag` returns the `diag()` payload (route test). Fails today.
- [ ] GREEN: add the `GET /diag` route to `server.ts`; leave `/health` as the bare fast probe.
- [ ] RED: host doctor `storage` area emits a store-drift finding when probed `/diag` reports
      `indexHealthy=false` (or store SHA != host HEAD); clean fact when healthy (mock `/diag`).
- [ ] GREEN: add a host to store `/diag` probe in `storageArea()`; fold into facts/findings;
      emit `trevor.store.diag` span.
- [ ] RED: schema `user_version` stamped at startup and bumped via a migration constant.
- [ ] GREEN: add the `user_version` stamp/migration hook.
- [ ] REFACTOR: one `diag()` owner; doctor host/web parity test still passes; module comments
      on the `/diag` seam + probe.

### M2: Supervisor watchdog (detect wedge, kill + KeepAlive respawn) - 0/7

- [ ] RED: watchdog trips after N consecutive `/health` failures over the window (injected
      000/timeout) and calls terminate exactly once, not per poll. Fails today.
- [ ] GREEN: add `apps/supervisor/src/watchdog.ts` - interval loop via `fetchWithTimeout`
      against store `/health`; on sustained failure find + terminate the store PID; emit
      `store_wedge_detected` / `store_restarted`; wire into `main()`.
- [ ] RED: startup/bootstrap grace - a booting store is NOT killed until the grace elapses.
- [ ] GREEN: implement the startup grace.
- [ ] RED: restart-storm guard - on repeated failed recovery, back off exponentially, cap
      attempts, emit `store_recovery_exhausted` instead of kill-looping.
- [ ] GREEN: implement backoff + cap + alarm span; verify `/health` 200 within a grace before
      resuming normal polling.
- [ ] REFACTOR: extract "find the store PID" into the launcher platform; reuse `waitForStore`;
      module comment on the supervision-not-communication boundary.

### M3: Circuit breaker (in-thread bounded query budget) - 0/7

- [ ] SPIKE / RED (A-001): characterize Node 24 `vdbeOp` per-statement cap - tiny cap on a temp
      `DatabaseSync`, run a scan, assert it throws a typed limit error; record the outcome via
      `validate-assumption`.
- [ ] GREEN: if supported, set a per-statement `vdbeOp` ceiling (legit indexed lookup passes,
      large scan aborts); surface a typed `StoreQueryBudgetError` from `query()`. If not, skip
      to the breaker-only path and note it.
- [ ] RED: post-slow-query breaker opens over budget, fast-fails subsequent queries for the
      cooldown, then half-open probes and closes. Fails today.
- [ ] GREEN: implement the breaker in `query()`; emit `circuit_open`/`circuit_closed`; map the
      typed error to HTTP 503 in `server.ts`.
- [ ] RED: a tripped breaker on a write throws BEFORE mutating - read model + `MAX(seq)+1` seq
      invariant never half-applied. Fails today.
- [ ] GREEN: breaker/budget check precedes any mutation; graceful read-path degradation (503,
      no crash).
- [ ] REFACTOR: fold `vdbeOp` cap + breaker into one bounded-query policy composed with the
      existing `slow_query` span; update the seam comment; docs.

### Gate 1->done

- [ ] `pnpm test` (unit + web) passes, including M1/M2/M3 tests.
- [ ] `pnpm typecheck` + `pnpm lint` clean.
- [ ] Doctor host/web parity test still passes.
- [ ] Integrated repro: simulate the 2026-07-06 wedge (drop index / force slow query) and
      confirm all three layers fire - doctor flags `indexHealthy=false`, watchdog kills +
      respawns in-window, breaker aborts/short-circuits the over-budget query.

---

## Deferred / Follow-up

Event-log retention / compaction (the 94k-event `trevor-local` slow burn) stays deferred under
45.1 D-005 to its own future plan. Not in 45.2.

## Superseded / Obsolete

None.
