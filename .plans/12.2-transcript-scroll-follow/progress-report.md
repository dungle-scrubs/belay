# Transcript Scroll Follow - Progress Report

## Summary

> Current focus: M4: Full verification + manual EZE

- Total checklist items: 24
- Completed: 21
- Current cutoff blockers: 3

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

- [x] RED: unit tests - an upward user gesture unpins immediately, no position precondition or intent window (scroll-follow.test.ts, initially failed on the missing module)
- [x] GREEN: state machine skeleton (pinned/unpinned; direction-carrying gesture inputs; re-pin commands) - `createScrollFollowController` in scroll-follow.ts
- [x] RED: unit tests - re-pin only via a downward gesture ending within AT_BOTTOM_TOLERANCE, jump, or submit; upward transit through the band never re-pins
- [x] GREEN: re-pin arbitration (down-arrival-in-band re-pin; a null baseline defers direction until two samples exist so a first scroll never false-re-pins)
- [x] RED: unit tests - while unpinned every follow write is denied and anchor-compensation writes are allowed; while pinned follow writes pass; approved writes are recognized on the next scroll event
- [x] GREEN: write classification, arbitration, and self-write bookkeeping (pendingSelfOffset matched with a 1.5px epsilon; dev-only structured warn per denied writer, deduped per unpinned span)
- [x] REFACTOR: bottom-distance math imported from scroll.ts (no duplication, D-003); module comment (Responsible for / Not for); `snapshot()` debug getter. 13 unit tests green; web typecheck + biome clean.

### M3: Wire the web app through the controller

- [x] RED: adapter tests - wheel-up while pinned unpins synchronously within the same event; pinned exposed to render for the jump button (use-scroll-follow.test.tsx rewrite; `atBottom` via useSyncExternalStore)
- [x] GREEN: rewrite use-scroll-follow.ts as the adapter over the controller (stable controllerRef, sync refs, useSyncExternalStore); pin state is hoisted (the controller lives in the adapter, threaded down, so VirtualTranscript remounts reuse it)
- [x] RED: component tests - while unpinned no follow write is approved (append, totalSize, settle); while pinned appends DO follow; the settle loop reveals-on-unpin instead of force-scrolling; panel-host drops the not-ready scroll guard (verified by Lane B exercising the not-ready path)
- [x] GREEN: collapse the follow effects into controller requests (followLiveEdge -> requestWrite); route scrollToFn, the settle loop, and the panel-host wheel/scroll listeners (direction from deltaY) through the controller
- [x] RED: component test - a re-measure while unpinned is accepted as anchor-compensation (not swallowed), keeping the viewport stationary; jsdom cannot measure net-zero px so the acceptance path is asserted
- [x] GREEN: anchor-compensation acceptance path (scrollToFn classifies unpinned writes as compensation and allows them, EXCEPT a correction that would land at the live edge - a lagging-anchorTo follow in disguise - which is swallowed, D-007)
- [x] GREEN: the three M1 specs pass; four pre-existing Lane B scroll specs + app-boot + smoke stay green - 12 consecutive `pnpm test:e2e:browser` runs, 0 flakes
- [x] REFACTOR: deleted the 700ms intent window + `onUserScrollIntent` + the dead `mayAutoFollow` gate; added `data-transcript-pinned`; module comments; DOM contract unchanged (scroll element identity, data-transcript-scroll/-virtual-list/-ready/-row-count, jump aria labels) except the additive attribute

## Phase 3: Verification

### M4: Full verification + manual EZE

- [ ] GREEN: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e:browser` all green
- [ ] RED: manual EZE feel-check against a live streaming session - read while streaming (no yank), slow-scroll up (no tug), rapid flick up (no reset); any residual jitter is a finding
- [ ] REFACTOR: record verification commands + feel-check results; confirm the plan 33/35/34 notes still describe the landed contract
