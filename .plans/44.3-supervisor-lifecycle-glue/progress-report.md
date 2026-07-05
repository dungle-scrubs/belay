# Supervisor Lifecycle Glue - Progress Report

## Summary

- **Current cutoff blockers:** 0
- **Completed current work:** 21
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** Complete. useLaunch extracted (the ONE launch machine); the picker and the
  session-view "start host" both drive it; recovery states (failed/retry, restarting label) landed.
  Only the Storybook visual-regression baselines remain (generated in the pinned container).

## Completed Current State / Hard Dependencies

- [x] D-094 session lifecycle controls - recovery affordances stay consistent with the lifecycle model.
- [x] D-085 project launcher - reuse/spawn/replace-stale semantics surfaced here.

## Current Cutoff Blockers

### Phase 0 - Dependency gate

- [x] `44.1-supervisor-foundation` merged - supervisor, `session.launch` result (incl. failure), replace-stale decision.
- [x] `44.2-browser-folder-sessions` merged - the unified launch state machine this plan extends.

### Phase 1 - M1: No-host session start

- [x] RED: Test/story that a `host: "no host"` session with a known root shows a "start host" affordance. (`host-launch-status.test.tsx`, `side-panel.stories.tsx` NoHostStartable)
- [x] GREEN: Render "start host" in the session view for a no-host session with a resolvable root. (`host-launch-status.tsx` + `app.tsx` statusNode no-host branch)
- [x] RED: Test that activating it publishes `session.launch.requested` for the known root and enters "starting host…". (`use-launch.test.tsx` launch-publishes-and-enters-starting + `host-launch-status.test.tsx` startable-fires-onStart)
- [x] GREEN: Wire the start affordance to the launch request + shared launch state. (second `useLaunch` in `app.tsx`, armed control subscription)
- [x] REFACTOR: Derive the "known root" once - `resolveKnownRoot` (log `workspace`/`cwd` -> inventory summary -> `projects.json`), shared by picker + session-view start. (`derive.ts` + `derive.test.ts`)

### Phase 1 - M2: Stale host and failed launch

- [x] RED: Test that `session.launch.result { status: "failed", error }` renders a named error + explicit `Retry`. (`use-launch.test.tsx` failed-state, `new-session-picker.test.tsx` failed-swaps-Retry, `host-launch-status.test.tsx` failed)
- [x] GREEN: Extend the launch state machine with `failed` + `retry`; render error + `Retry`. (`use-launch.ts` LaunchPhase `failed`; picker footer + badge Retry)
- [x] RED: Test that `Retry` re-publishes the same request and returns to "starting host…". (`use-launch.test.tsx` retry-re-publishes)
- [x] GREEN: Wire `Retry`. (`useLaunch.retry` re-publishes `lastRootRef`; picker `onRetry`, badge `onRetry`)
- [x] RED: Test that a `replace-stale` outcome renders a distinct "restarting host…" label resolving to `host.online`. (`host-launch-status.test.tsx` restart-label + `use-launch.test.tsx` stale-restart-navigates)
- [x] GREEN: Surface the `stale`/"restarting" label as a variant of `starting`. (`HostLaunchStatus` `restarting` prop, driven in `app.tsx` by `hostAnnouncement(events) !== null`)
- [x] REFACTOR: Fold `stale`/`failed`/`retry` into 44.2's one launch state machine; assert no second model. (all launch state lives in `use-launch.ts`; `use-supervisor` consumes it and its tests stay green; `app.tsx` reuses the same hook - no second model)

### Gate 1

- [x] A no-host session offers a working "start host".
- [x] A failed launch shows a named error + `Retry`; `Retry` re-launches.
- [x] A stale host shows "restarting host…" and resolves to online.
- [x] "Supervisor unavailable" is a surfaced, retryable failure, not a hang. (an explicit `failed` result -> failed+Retry; a launch that gets no result within the host.online window -> idle+error, re-initiable via the same affordance - never an unbounded spinner.)
- [x] No launch state model exists outside 44.2's unified machine (`useLaunch`).

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
