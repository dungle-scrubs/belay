# Supervisor Lifecycle Glue - Progress Report

## Summary

- **Current cutoff blockers:** 19
- **Completed current work:** 2
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** Phase 0 - Dependency gate (`44.1` and `44.2` must land first).

## Completed Current State / Hard Dependencies

- [x] D-094 session lifecycle controls - recovery affordances stay consistent with the lifecycle model.
- [x] D-085 project launcher - reuse/spawn/replace-stale semantics surfaced here.

## Current Cutoff Blockers

### Phase 0 - Dependency gate

- [ ] `44.1-supervisor-foundation` merged - supervisor, `session.launch` result (incl. failure), replace-stale decision.
- [ ] `44.2-browser-folder-sessions` merged - the unified launch state machine this plan extends.

### Phase 1 - M1: No-host session start

- [ ] RED: Test/story that a `host: "no host"` session with a known root shows a "start host" affordance.
- [ ] GREEN: Render "start host" in the session view for a no-host session with a resolvable root.
- [ ] RED: Test that activating it publishes `session.launch.requested` for the known root and enters "starting host…".
- [ ] GREEN: Wire the start affordance to the launch request + shared launch state.
- [ ] REFACTOR: Derive the "known root" once (from `host.online` workspace/cwd or `projects.json`), shared by picker + session-view start.

### Phase 1 - M2: Stale host and failed launch

- [ ] RED: Test that `session.launch.result { status: "failed", error }` renders a named error + explicit `Retry`.
- [ ] GREEN: Extend the launch state machine with `failed` + `retry`; render error + `Retry`.
- [ ] RED: Test that `Retry` re-publishes the same request and returns to "starting host…".
- [ ] GREEN: Wire `Retry`.
- [ ] RED: Test that a `replace-stale` outcome renders a distinct "restarting host…" label resolving to `host.online`.
- [ ] GREEN: Surface the `stale`/"restarting" label as a variant of `starting`.
- [ ] REFACTOR: Fold `stale`/`failed`/`retry` into 44.2's one launch state machine; assert no second model.

### Gate 1

- [ ] A no-host session offers a working "start host".
- [ ] A failed launch shows a named error + `Retry`; `Retry` re-launches.
- [ ] A stale host shows "restarting host…" and resolves to online.
- [ ] "Supervisor unavailable" is a surfaced, retryable failure, not a hang.
- [ ] No launch state model exists outside 44.2's unified machine.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
