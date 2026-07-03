# Transcript Scroll Follow - Progress Report

## Summary

> Current focus: M2: Pure state machine (scroll-follow.ts)

- Total checklist items: 24
- Completed: 6
- Current cutoff blockers: 18

## 0. Hard Dependencies

- [x] 09.2 Lane B browser e2e infrastructure (playwright.config.ts, run-browser-e2e.ts, lane-b-fixtures.ts, transcript-scroll.spec.ts, `pnpm test:e2e:browser`)
- [x] The current scroll stack this plan rewrites: scroll.ts, use-scroll-follow.ts, virtual-transcript.tsx follow effects, panel-host.tsx wiring

## Phase 1: Reproduce

### M1: Lane B reproduction specs

- [x] RED: spec - append while reading (small scroll-up within the old tolerance band) does not move the viewport to the live edge - failing against current code. Observed failure: after a -24px reading nudge (within the 40px band) + `appendExchange`, `bottomDeltaPx` is 0 (viewport snapped to the live edge) and the jump button is absent - the reading nudge is never honored. (Race sub-case deferred to a component test with fake timers, D-006: a WS-round-tripped append outruns the old async unpin window, so it cannot be raced reliably in Lane B.)
- [x] RED: spec - slow upward wheel during a streaming turn makes monotonic upward progress (sampled scrollTop never increases) - failing against current code. Observed failure: `sample 1 (3746) rose above sample 0 (3726)` - the streaming re-measure tug pulls scrollTop back down between reading steps.
- [x] RED: spec - rapid wheel flick from the bottom unpins, stays unpinned, never snaps downward, lands where the gesture says - failing against current code. Observed failure: jump button count 0 - each row arriving mid-flick re-pins the lagging pin state and yanks to the new live edge, so the flick never breaks free (reproduced via appends between bursts, D-006; discrete Playwright wheels have no momentum).
- [x] GREEN: four pre-existing Lane B scroll specs still pass unmodified (stick-to-bottom, unpin+no-yank, mid-stream follow, jump-to-bottom); app-boot + smoke pass; perf skipped (RUN_PERF unset). Each new spec's failure mode recorded above as reproduction evidence.

## Phase 2: The follow controller

### M2: Pure state machine (scroll-follow.ts)

- [ ] RED: unit tests - an upward user gesture unpins immediately, no position precondition or intent window
- [ ] GREEN: state machine skeleton (pinned/unpinned; direction-carrying gesture inputs; re-pin commands)
- [ ] RED: unit tests - re-pin only via a downward gesture ending within AT_BOTTOM_TOLERANCE, jump, or submit; upward transit through the band never re-pins
- [ ] GREEN: re-pin arbitration
- [ ] RED: unit tests - while unpinned every follow write is denied and anchor-compensation writes are allowed; while pinned follow writes pass; approved writes are recognized on the next scroll event
- [ ] GREEN: write classification, arbitration, and self-write bookkeeping
- [ ] REFACTOR: bottom-distance math imported from scroll.ts (no duplication); module comment; debug snapshot getter

### M3: Wire the web app through the controller

- [ ] RED: adapter tests - wheel-up while pinned unpins synchronously within the same event; pinned exposed to render for the jump button
- [ ] GREEN: rewrite use-scroll-follow.ts as the adapter over the controller; hoist pin state above VirtualTranscript remounts
- [ ] RED: component tests - while unpinned: appends, totalSize growth, and the settle loop write nothing to scrollTop; while pinned they follow; settle loop terminates on user intent; panel-host no longer drops scroll events while not ready
- [ ] GREEN: collapse the follow effects into controller requests; route scrollToFn, the settle loop, and the panel-host listeners (direction extraction) through the controller
- [ ] RED: component test - above-viewport re-measure keeps viewport content visually stationary while unpinned (anchor compensation, net-zero movement)
- [ ] GREEN: anchor-compensation acceptance path
- [ ] GREEN: the three M1 specs pass; four pre-existing Lane B scroll specs + app-boot + smoke stay green (`pnpm test:e2e:browser`)
- [ ] REFACTOR: delete intent-window plumbing and dead gates; add data-transcript-pinned; module comments; DOM contract unchanged except the additive attribute

## Phase 3: Verification

### M4: Full verification + manual EZE

- [ ] GREEN: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e:browser` all green
- [ ] RED: manual EZE feel-check against a live streaming session - read while streaming (no yank), slow-scroll up (no tug), rapid flick up (no reset); any residual jitter is a finding
- [ ] REFACTOR: record verification commands + feel-check results; confirm the plan 33/35/34 notes still describe the landed contract
