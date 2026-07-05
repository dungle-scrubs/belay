# Session-Store Inventory Performance - Implementation Plan

## 0. Hard Dependencies

- [x] None. This is a self-contained fix inside `apps/session-store`; it preserves the existing
  `/sessions` REST + `/sessions/{id}/stream` transport contract, so nothing else has to change to
  build it. <!-- D-006 -->
- [x] Considered and **skipped** (no accommodation needed): `.plans/48-desktop-shell-tauri` references
  the session-store only as a supervised local service reachable over the *same* HTTP/WebSocket
  transport. This plan changes the store's **internal** inventory computation, not the wire contract
  `48` relies on, so `48` needs no forward-dependency edit. `46`/`49` do not touch the store's query
  path. <!-- D-006 -->

## 1. Architecture

### 1.1 The bug (what wedges the whole app) <!-- D-001 -->

The session-store (`apps/session-store`, port 17424) is the single shared transport every session's
web UI and host talk through. When it starves, **every** session goes dark - not one. It starves like
this:

- The web polls `GET /sessions` **every 4 seconds** while the sidebar / resume chooser is open
  (`apps/web/src/resume/use-inventory.ts`, `refetchInterval: 4_000`).
- `GET /sessions` calls `SessionLog.inventory()` (`apps/session-store/src/log.ts`), which runs a full
  `LEFT JOIN events … GROUP BY sessionId` aggregate over the **entire** events table, then calls
  `projectRow()` for **every** session - each firing **8 more subqueries** (`latestOfType` ×6,
  `firstOfType`, `eventsOfTypes`). With 183 sessions that is **~1,464 subqueries + a `JSON.parse` per
  returned row** per poll. There is **no index on `type`** (only the `(sessionId, seq)` PRIMARY KEY),
  so each type-filtered subquery is a seq-ordered scan of that session's whole history.
- `node:sqlite` `DatabaseSync` is **synchronous on the single event-loop thread**. So the whole
  ~1.67s inventory computation blocks *everything* - `/health`, WebSocket replay/tail, event POSTs -
  until it returns.

Measured on the live DB (183 sessions, 289,680 events, 360 MB; worst session `trevor-local` =
94,408 events): raw aggregate SQL is 0.18s, but the live endpoint is **1.67s** (the gap is the ~1,464
synchronous subquery round-trips + per-row JSON parsing). At a 4s poll that is ~42% event-loop
saturation from **one** tab; add the main app's sidebar, extra tabs, reconnect storms, and the
supervisor, and the one thread saturates continuously → sustained ~90% CPU and periodic **HTTP 000**
(the observed outage). It worsens monotonically as the log grows.

**Prior art (learn, don't copy):** legacy Trevor's resume chooser has the same N+1 shape (a per-session
full-transcript replay), but never wedged because it (a) capped at `LIMIT 25`, (b) fired **once per
overlay open, not on a timer**, and (c) did its heavy work in **async** file I/O rather than
event-loop-blocking synchronous SQLite. Legacy also already ships the *right* pattern elsewhere -
`hook_handler_summaries` maintains a rolling per-key summary **upserted on append** - but never applied
it to the session inventory. That incremental read model is exactly the fix. <!-- D-002 -->

### 1.2 The fix

Three layers, in priority order:

1. **Incremental in-memory inventory read model (core).** <!-- D-002 --> A new
   `InventoryProjection` holds one summary row per session in memory (`Map<sessionId,
   Omit<InventoryRow, "hostPresent">>`). It is **warmed once at startup** by a single `log.inventory()`
   pass, then **updated on every write** (`append`, `ensureSession`, `deleteSession`) - each of which
   already carries the `sessionId` + event `type` + event needed to update the affected row's fields.
   `GET /sessions` reads the map and folds in live host presence (`hub.hasLiveHost`) - **zero SQLite
   per poll**. This removes the ~1,464 subqueries + parses from the hot path entirely.

2. **Type index (supporting).** <!-- D-003 --> `CREATE INDEX IF NOT EXISTS events_session_type_seq ON
   events(sessionId, type, seq)` in the schema init. Validated to flip the type-lookups from
   `SEARCH events (sessionId=?)` (scan the whole session, filter by type) to
   `SEARCH events (sessionId=? AND type=?)` (direct seek, seq order free from the index → no filesort).
   After the read model lands, `inventory()` only runs once at startup and `summaryRow()` only on the
   permanent-delete gate; the index keeps both, plus any residual per-session lookup, bounded. +16 MB,
   0.16s to build.

3. **Guardrail: no unbounded synchronous query on a request path (transport isolation).**
   <!-- D-004 --> The event loop must never again be monopolized by a request-triggered full scan.
   Encode it two ways: (a) `GET /sessions` provably issues **zero** SQLite queries once warm (a query
   counter on `SessionLog`, asserted in a test), and (b) a structured **slow-query** telemetry event
   whenever any synchronous store query exceeds a threshold, so a regression is observable rather than
   silent.

### 1.3 Boundaries

| Module | Owns | Does NOT own |
|--------|------|--------------|
| `apps/session-store/src/log.ts` (`SessionLog`) | The durable SQLite substrate: schema (+ the new `type` index), append/seq assignment, `inventory()` (startup warm only), `summaryRow()` (delete gate), replay reads. A per-query duration/count hook for the guardrail. | The live read model (moves to `InventoryProjection`). |
| `apps/session-store/src/inventory.ts` (**new**, `InventoryProjection`) | The in-memory inventory read model: warm-from-scan at startup, incremental per-event update, `rows()` read, `remove()`/`ensure()`. Inspectable state (size, per-session row) for diagnostics. | Durable storage; host presence (folded in by the server from `hub`). |
| `apps/session-store/src/server.ts` | Wiring: warm the projection at construction; feed it on `POST /sessions` (ensure), `POST /events` (append), and `DELETE` (remove); serve `GET /sessions` from `projection.rows().map(summarize)`. | The projection logic itself. |
| `apps/web/src/resume/use-inventory.ts` | Unchanged - the 4s poll stays (now cheap). <!-- D-008 --> | - |

**Key non-change:** `node:sqlite` stays **synchronous**; no worker thread, no async driver.
<!-- D-007 --> The append path relies on synchronous, non-interleaving `MAX(seq)+1` assignment for
gap-free per-session seq (a load-bearing invariant documented in `log.ts`). The fix makes queries
cheap/bounded instead of moving them off-thread. The one synchronous path this plan does **not**
shorten is replay-on-connect of a very large session (`readAfter` of a 94k-event log); it is bounded
per-connect and is handled by the deferred log-hygiene follow-up (below), not here.

### 1.4 Observability

- **Inspectable projection state:** `InventoryProjection` exposes its size and a per-session row lookup
  for diagnostics/tests (the read model is otherwise opaque in memory).
- **Structured slow-query events:** `SessionLog` emits a `store.slow_query` structured log (query name,
  `durationMs`, threshold) when a synchronous query exceeds the guardrail threshold.
- **Query counter:** a monotonically increasing per-`SessionLog` query count, used by the guardrail test
  to assert `GET /sessions` touches SQLite zero times once warm.

---

## 2. Phase 1: Cheap, guarded inventory

**Goal:** `GET /sessions` is served from an in-memory read model in O(sessions) with zero SQLite per
poll; type lookups are indexed; and a single request can no longer wedge the event loop.

**Gate from previous:** none (independent plan).

### M1: Type index

- **Dependencies:** none
- **Effort:** S (1-3d)
- **Tasks:**
  1. RED: characterization test asserting `latestOfType`/`firstOfType` on a session use an
     `(sessionId, type)` index path, not a full-session scan (assert via `EXPLAIN QUERY PLAN` on the
     store's DB, or via a query-plan helper) - fails today (only the PK autoindex exists).
  2. GREEN: add `CREATE INDEX IF NOT EXISTS events_session_type_seq ON events(sessionId, type, seq)` to
     the `SessionLog` schema init; the plan flips to the `(sessionId=? AND type=?)` seek.
  3. RED: test that the index is created idempotently on an existing (pre-index) DB (open twice, no
     error, index present) - the real DB already has data, so creation must be `IF NOT EXISTS` and not
     block on a rebuild.
  4. GREEN: confirm idempotent creation on open.
  5. REFACTOR: co-locate the index DDL with the table DDL and note in a schema comment why the
     `(sessionId, type, seq)` order matters (seek + free seq order for the type projections).

### M2: Incremental in-memory inventory read model

- **Dependencies:** M1
- **Effort:** M (3-7d)
- **Tasks:**
  1. RED: `InventoryProjection` warmed from a seeded log returns the same rows `log.inventory()` would
     (parity test against the existing projection) - fails (module does not exist).
  2. GREEN: `InventoryProjection` with a warm-from-`log.inventory()` constructor and `rows()`.
  3. RED: appending an event updates only the affected session's row - `eventCount`, `updatedAt`, and
     the projected slots (`hostOnline` latest, `firstUser` set-once, `lifecycle` appended,
     `archived`/`rename`/`deleted`/`forkedFrom`/`tangentOf` latest) - matching what a fresh
     `projectRow` would compute for that session.
  4. GREEN: `recordAppend(event)` incremental update covering every projected field; `ensure(sessionId,
     createdAt)` creates an empty row; `remove(sessionId)` drops it.
  5. RED: `GET /sessions` reflects a just-appended event / a just-created / a just-deleted session on
     the next request, with live host presence folded in from the hub (an end-to-end server test).
  6. GREEN: wire the projection into `createSessionStore` - warm at construction, feed on
     ensure/append/delete, serve `GET /sessions` from `projection.rows().map(summarize)`.
  7. REFACTOR: make `SessionLog.inventory()` the startup-warm/parity path only; document the read-model
     boundary (durable log vs. derived projection) in module comments.

### M3: Guardrail - no unbounded synchronous query on a request path

- **Dependencies:** M2
- **Effort:** S (1-3d)
- **Tasks:**
  1. RED: after warm-up, a `GET /sessions` request issues **zero** SQLite queries (assert against a
     query counter on `SessionLog`) - fails against the pre-M2 handler.
  2. GREEN: confirm the served path reads only the projection (counter stays flat across polls).
  3. RED: a synchronous query exceeding the slow-query threshold emits a structured `store.slow_query`
     event (query name + `durationMs`); a fast query emits nothing.
  4. GREEN: add the per-query duration hook + threshold + structured emit in `SessionLog`.
  5. REFACTOR: consolidate the counter + timing hook into one query-instrumentation seam; expose
     `InventoryProjection` size/lookup for diagnostics.

### Gate 1 (done)

- [ ] `GET /sessions` issues zero SQLite queries once warm; the endpoint is O(sessions) in memory.
- [ ] `EXPLAIN QUERY PLAN` for the type lookups uses `events_session_type_seq` (seek, no filesort).
- [ ] Projection parity: warmed rows and per-event updates match `log.inventory()`/`projectRow`.
- [ ] A slow synchronous query emits a `store.slow_query` structured event.
- [ ] `pnpm --filter @trevor/session-store test` and typecheck pass; the `/sessions` REST + stream
      contract is unchanged (existing server tests green).

---

## 3. Non-Goals (this plan)

- **Runaway-log hygiene (deferred follow-up).** <!-- D-005 --> Bounding/chunking replay-on-connect and
  pruning/capping ephemeral logs like `trevor-local` (94,408 events) is the *secondary*
  reconnect-storm blocker and pulls log-retention/compaction design into scope. Deferred to its own
  plan; not built here.
- **Async / worker-thread SQLite.** <!-- D-007 --> Explicitly not done; the seq-assignment invariant
  depends on synchronous, non-interleaving writes.
- **Event-driven inventory push.** <!-- D-008 --> The store notifying clients on inventory change
  (retiring the 4s poll) is a future direction, not part of 45.1.

---

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| In-memory projection drifts from the DB (missed field on an event type) | high | medium | Parity test (M2/1) against `log.inventory()`; the incremental update covers exactly the fields `projectRow` projects; warm-from-scan on every restart re-baselines from the durable log. |
| Projection assumes a single store writer | med | low | The store is single-process by design; a second writer is the operational anomaly the ops-side single-owner addresses, out of scope here. Warm-on-restart limits blast radius to one process lifetime. |
| Index build blocks startup on the 360 MB DB | low | low | `CREATE INDEX IF NOT EXISTS` builds once (~0.16s measured) then is a no-op on subsequent opens. |
| Startup warm scan is itself the old 1.67s cost | low | high (once) | It runs **once** at startup, off the request hot path, and is bounded by the new index; not a per-poll cost. |

---

## 5. Validation Commands

```bash
pnpm --filter @trevor/session-store test
pnpm --filter @trevor/session-store exec tsc --noEmit
# live sanity after deploy: GET /sessions is fast + /health stays responsive under poll
curl -s -o /dev/null -w "%{time_total}s %{http_code}\n" http://127.0.0.1:17424/sessions
```

---

## 6. Decisions

Canonical decisions live in `.plans/45.1-session-store-inventory-perf/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts \
  query-decisions --plan "45.1-session-store-inventory-perf"
```

Key decisions referenced above use `<!-- D-NNN -->` markers (D-001 root cause; D-002 incremental read
model; D-003 type index; D-004 guardrail; D-005 scope/deferrals; D-006 numbering + no hard deps;
D-007 keep sqlite synchronous; D-008 client poll retained).
