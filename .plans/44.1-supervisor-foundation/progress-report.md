# Supervisor Foundation - Progress Report

## Summary

- **Current cutoff blockers:** 30
- **Completed current work:** 4
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Extract `@trevor/launcher`

## Completed Current State / Hard Dependencies

- [x] D-085 project launcher exists in `apps/trevor-cli` (launch/platform/host-registry/project/identity).
- [x] `03-filesystem-root-taxonomy` fixes launcher record roots under `TREVOR_STATE_HOME`.
- [x] Session transport contract - browser/host/supervisor communicate only over the session log.
- [x] `file.index` request/result side-channel is the prior-art shape for supervisor requests.

## Current Cutoff Blockers

### Phase 1 - M1: Extract `@trevor/launcher`

- [ ] RED: Characterization tests pinning `launch()` for new-project / reuse / replace-stale over a fake platform.
- [ ] GREEN: Create `packages/launcher` and move launch/resolve/decide/host-registry/lock logic behind an injected platform; re-point CLI imports.
- [ ] RED: Test that CLI and a non-CLI caller resolve the same project root + session id for the same cwd.
- [ ] GREEN: Expose a minimal `LauncherPlatform` port for non-CLI callers.
- [ ] REFACTOR: Split platform interface from node impl; keep `buildHostSpawnCommand` internal; add a module-level ownership comment.

### Gate 1->2

- [ ] `@trevor/launcher` builds and typechecks as a workspace package.
- [ ] `apps/trevor-cli` behavior unchanged (existing tests pass unmodified).
- [ ] CLI and a non-CLI caller share project/session identity in tests.

### Phase 2 - M2: Supervisor protocol events

- [ ] RED: Schema + round-trip tests for the three request/result pairs incl. `requestId`.
- [ ] GREEN: Define the six events + reserved control-session id constant in `packages/session`.
- [ ] RED: Test that a malformed supervisor request is rejected at the schema boundary.
- [ ] GREEN: Validate requests at the boundary before dispatch.
- [ ] REFACTOR: Reuse the `file.index` correlation helper rather than a parallel one.

### Gate 2->3

- [ ] All six events validate and round-trip.
- [ ] `requestId` correlates a result to its request.
- [ ] Malformed requests are rejected, not partially handled.

### Phase 3 - M3: Launch dispatch

- [ ] RED: Integration test - `session.launch.requested { root }` drives the launcher core (fake platform) and publishes `session.launch.result` with the session id + launched/reused status.
- [ ] GREEN: Implement `trevor supervisor` - subscribe to the control session, dispatch launch requests, publish results.
- [ ] RED: Test the supervisor is ensured-running as a shared local service (started once, reused if up).
- [ ] GREEN: Register the supervisor as a fourth ensured shared local service.
- [ ] REFACTOR: One handler per request type; enforce Richter-only.

### Phase 3 - M4: Native folder pick + recents

- [ ] RED: Test `folder.pick.requested` invokes the native picker (stubbed) and returns a POSIX path; cancel returns `{ cancelled: true }`.
- [ ] GREEN: Implement the native picker via `osascript choose folder`, local-only; publish `folder.pick.result`.
- [ ] RED: Test `projects.list.requested` returns `projects.json` entries recency-sorted, empty when absent.
- [ ] GREEN: Implement the recents reader over `@trevor/session/node-paths`.
- [ ] REFACTOR: Centralize the local-only guard + registry read; document native-picker degradation.

### Gate 3

- [ ] A control-session launch request spawns/reuses a host and returns its session id.
- [ ] Native folder pick returns a real path locally and reports unavailable when non-local.
- [ ] Recents come back recency-sorted from `projects.json`.
- [ ] Every exchange is on the session log; no private IPC.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
