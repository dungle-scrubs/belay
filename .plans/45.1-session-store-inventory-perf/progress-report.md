# Session-Store Inventory Performance - Progress Report

## Summary

- **Current cutoff blockers:** 10
- **Completed current work:** 12
- **Accepted/deferred follow-up:** 3
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M3 - Guardrail: no unbounded synchronous query on a request path

## Completed Current State / Hard Dependencies

- [x] Root cause confirmed live (D-001): `GET /sessions` → `log.inventory()` = full `GROUP BY`
  aggregate + ~1,464 type-filtered subqueries + per-row `JSON.parse` per 4s poll, run **synchronously**
  on the event-loop thread (~1.67s), blocking `/health`, streams, and POSTs → ~90% CPU / HTTP 000.
- [x] No hard dependencies (D-006): self-contained inside `apps/session-store`; preserves the
  `/sessions` REST + stream contract.
- [x] Downstream considered + skipped (D-006): `48-desktop-shell-tauri` relies only on the store's wire
  contract (unchanged); `46`/`49` do not touch the query path. No accommodation edits.
- [x] Fix approach decided (D-002/D-003/D-004): incremental in-memory read model + `events(sessionId,
  type, seq)` index + a no-unbounded-synchronous-query guardrail.
- [x] Both levers validated: index flips the type lookup from full-session scan to a seek (no filesort);
  the read model removes the ~1,464 subqueries + parses from the hot path.

## Current Cutoff Blockers

### Phase 1: Cheap, guarded inventory

**M1 - Type index**
- [x] RED: query-plan characterization - `latestOfType`/`firstOfType` use an `(sessionId, type)` index
  path, not a full-session scan (fails today: only the PK autoindex exists).
- [x] GREEN: add `CREATE INDEX IF NOT EXISTS events_session_type_seq ON events(sessionId, type, seq)` to
  the schema init; plan flips to `(sessionId=? AND type=?)` seek.
- [x] RED: index creation is idempotent on an existing pre-index DB (open twice, no error, index present).
- [x] GREEN: confirm idempotent `IF NOT EXISTS` creation on open.
- [x] REFACTOR: co-locate index DDL with table DDL + schema comment on why `(sessionId, type, seq)` order.

**M2 - Incremental in-memory inventory read model**
- [x] RED: `InventoryProjection` warmed from a seeded log returns the same rows as `log.inventory()`
  (parity) - fails (module absent).
- [x] GREEN: `InventoryProjection` with warm-from-`log.inventory()` constructor + `rows()`.
- [x] RED: appending an event updates only the affected session's row - `eventCount`, `updatedAt`, and
  the projected slots (`hostOnline` latest, `firstUser` set-once, `lifecycle` appended,
  `archived`/`rename`/`deleted`/`forkedFrom`/`tangentOf` latest) - matching a fresh `projectRow`.
- [x] GREEN: `recordAppend(event)` covering every projected field; `ensure(sessionId, createdAt)`;
  `remove(sessionId)`.
- [x] RED: `GET /sessions` reflects a just-appended event / just-created / just-deleted session next
  request, with live host presence folded in (end-to-end server test).
- [x] GREEN: wire the projection into `createSessionStore` - warm at construction; feed on
  ensure/append/delete; serve `GET /sessions` from `projection.rows().map(summarize)`.
- [x] REFACTOR: `log.inventory()` becomes startup-warm/parity only; document the durable-log vs.
  derived-projection boundary in module comments.

**M3 - Guardrail: no unbounded synchronous query on a request path**
- [ ] RED: after warm-up, a `GET /sessions` request issues **zero** SQLite queries (query counter on
  `SessionLog`) - fails against the pre-M2 handler.
- [ ] GREEN: served path reads only the projection (counter flat across polls).
- [ ] RED: a synchronous query over the slow threshold emits a structured `store.slow_query` event
  (name + `durationMs`); a fast query emits nothing.
- [ ] GREEN: per-query duration hook + threshold + structured emit in `SessionLog`.
- [ ] REFACTOR: consolidate counter + timing into one query-instrumentation seam; expose
  `InventoryProjection` size/lookup for diagnostics.

### Gate 1 (done)
- [ ] `GET /sessions` issues zero SQLite queries once warm; endpoint is O(sessions) in memory.
- [ ] `EXPLAIN QUERY PLAN` for the type lookups uses `events_session_type_seq` (seek, no filesort).
- [ ] Projection parity: warmed rows and per-event updates match `log.inventory()`/`projectRow`.
- [ ] A slow synchronous query emits a `store.slow_query` structured event.
- [ ] `pnpm --filter @trevor/session-store test` + typecheck pass; `/sessions` REST + stream contract
  unchanged.

## Accepted / Deferred Follow-up

Not blockers for 45.1; tracked for a later plan.

- [ ] DEFERRED (D-005): runaway-log hygiene - bound/chunk replay-on-connect and prune/cap ephemeral
  logs like `trevor-local` (94,408 events). The secondary reconnect-storm blocker; its own plan.
- [ ] NON-GOAL (D-007): async / worker-thread SQLite (would break the synchronous `MAX(seq)+1`
  seq-assignment invariant).
- [ ] NON-GOAL (D-008): event-driven inventory push replacing the 4s poll (future direction).
