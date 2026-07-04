# Durable Follow-Up Queue - Progress Report

## Summary

- **Current cutoff blockers:** 0
- **Completed current work:** 64
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** Done - all milestones landed

Implementation notes / deviations (for the gate re-run + simplify pass):

- **Supersede = retraction + separate replacement, not an inline replacement.** The `user.supersede`
  event (`packages/session/src/protocol.ts`) carries ONLY the retracted `eventId`s + a `reason`
  (`fold`/`unqueue`/`recall`). The Escape-fold publishes its folded steering prompt as an ordinary
  `user.message` alongside the supersede, so it reuses the whole existing turn machinery (scheduler
  drain, projection, catch-up) rather than teaching `startTurn` to run an inline replacement. Same
  durable semantics, less coupling.
- **The durable queue is derived, not stored twice.** One pure ordering rule -
  `pendingFollowUps` (`packages/session/src/follow-up-queue.ts`) - is shared by the host leader catch-up
  and the web queue panel, so they can never disagree.
- **The projection collapse was scoped by comment + tests, not rewritten.** Answered follow-ups already
  stay distinct (each carries its reply); the transient consecutive-user run only ever collapses the
  pending/abandoned tail, and the caught-up prompt is re-admitted at the tail so each turn's prompt is
  correct. Superseded prompts are excluded outright.
- **M6 recall ring reuses the existing prompt-history primitive** (`apps/web/src/composer-storage.ts` +
  `use-prompt-history.ts`) - already capped + session-keyed localStorage. M7 pull-into-composer records
  the pulled prompt into that same ring, so re-submit re-enqueues durably.
- **Drain seam:** follow-ups drain at the turn-completion boundary (one-turn-at-a-time), each carrying
  its own model snapshot (D-065 `model` on `user.message`), which satisfies the 09.1 model-snapshot
  intent without a mid-turn drain.
- **Storybook:** `queued-prompts.stories.tsx` covers the queued panel states (single / multiple /
  with-artifact); folded + superseded resolve to queue changes (the folded prompt becomes a queued row,
  a superseded row disappears) rather than separate renders. No PNG baselines added (per the brief).

## Completed Current State / Hard Dependencies

- [x] Shipped browser send queue (plan 07): `apps/web/src/send-queue.ts` (`QueuedPrompt`, `enqueue`/`drainHead`/`steer`/`clear`, `foldSteer`/`foldQueuedSteer`), `apps/web/src/hooks/use-send-queue.ts` (busy-gated drain effect), `apps/web/src/esc-action.ts`, `apps/web/src/components/chat/queued-prompts.tsx`.
- [x] Host turn scheduler + catch-up: `apps/agent-host/src/agent/turn-scheduler.ts` (`submit`/`drain`/`processCompletion`, `pendingCatchUp`, `isAnswerablePrompt`, `lastStartSeq`), wired in `apps/agent-host/src/main.ts` (`noteTurn`, `onBecomeLeader`, `goLive`, `reapOrphans`).
- [x] History projection collapse: `apps/agent-host/src/agent/history-projection.ts` (`pushUser` collapses consecutive user turns to the latest) - the behavior M2 scopes.
- [x] `user.message` shape with stable `eventId` + ordered `seq`: `packages/session/src/event.ts`, `packages/session/src/protocol.ts` (`events.userMessage`), `packages/session/src/protocol-decode.ts`.
- [x] Per-item model snapshot on `QueuedPrompt` (umbrella D-065): `apps/web/src/send-queue.ts` snapshots `provider`/`reasoning`/`model` at submit.
- [x] Compatibility anchors held by tests: `.plans/34-transcript-image-rendering` (artifact-through-replay), `.plans/37-tangents` (queue must not bleed into tangent state), `.plans/31-action-shimmer-status` ("steering" label).

## Current Cutoff Blockers

### Forward Dependency

- [x] `.plans/09.1-mid-turn-model-switch` reaches implementing/complete so Phase 1 finalizes the drain at its switch boundary (interim drain point is clearly marked until then). *Model-switch infra (`model.switch.requested`/`model.switched`, `mid-turn-switch.test.ts`) is landed; the durable queue drains at the turn-completion boundary with per-item model snapshots (D-065).*

### M1 - Publish follow-ups at submit (host owns scheduling)

- [x] RED: Characterize the current drip-feed - a second follow-up submitted mid-turn is withheld in `useSendQueue` and absent from the durable log until the active turn completes.
- [x] GREEN: Publish each follow-up as a `user.message` at submit time, carrying its model snapshot (D-065); `TurnScheduler.submit` defers it behind the active turn.
- [x] RED: Test that after queuing N follow-ups and disconnecting the browser, all N are on the durable log and the host drains them.
- [x] GREEN: Retire the browser busy-gated drain/in-flight latch; submit becomes a thin immediate-publish path.
- [x] REFACTOR: Remove the dead drain/latch machinery from `useSendQueue`; source the rendered queue from the log (`queuedPromptsFrom`).

### M2 - Multi-prompt in-order catch-up + scoped projection collapse

- [x] RED: Host test that with N unanswered follow-ups, a started/standby leader runs ALL in `seq` order, not just the latest.
- [x] GREEN: Extend catch-up to drain all unanswered prompts in order via the existing scheduler (`pendingFollowUps` + the `onBecomeLeader` loop).
- [x] RED: Test `history-projection.ts` no longer collapses queued durable follow-ups, while still collapsing the abandoned-turn (unanswered, no queue) case.
- [x] GREEN: Scope the consecutive-user collapse to the abandoned-turn case; queued follow-ups stay distinct ordered turns.
- [x] RED: Test the attempt-watermark still prevents re-running an attempted-then-orphaned prompt (no restart loop).
- [x] GREEN: Preserve the `lastStartSeq` / orphan-reap interaction under multi-prompt catch-up (the positional FIFO claim in `pendingFollowUps`).
- [x] REFACTOR: Keep catch-up + projection one tested ordering rule with a single "answerable and not superseded" predicate seam.

### Gate 1-2

- [x] N follow-ups queued then client disconnected: the host drains all N, in order, with no client connected.
- [x] A host restart mid-backlog resumes draining the remaining unanswered prompts in order.
- [x] An attempted-then-orphaned prompt is not re-run; no restart loop.

### M3 - Supersession event + exclusion predicate

- [x] RED: Protocol tests for a supersede event carrying superseded `eventId`s + an optional replacement (constructor + `DecodedEvent` member + decode).
- [x] GREEN: Add the supersede event + decode + lifecycle/inventory registration (routing-characterization).
- [x] RED: Test catch-up + projection treat a superseded `user.message` as not-to-run ("unanswered AND not superseded"), including after restart.
- [x] GREEN: Apply supersession in the catch-up predicate and the projection fold.
- [x] REFACTOR: Keep supersession a pure fold over the log (`supersededMessageIds`); name the predicate seam so fold and unqueue share it.

### M4 - Escape-fold as supersede-with-replacement

- [x] RED: Web + host test that first Escape with N durable queued prompts emits ONE supersede-with-replacement; the host runs the folded prompt after the active turn; the transcript shows the fold, not N runs.
- [x] GREEN: Reroute `foldQueuedSteer` / first-Escape in `esc-action.ts`/`app.tsx` to publish the supersede+replacement instead of clearing local state.
- [x] RED: Test second Escape still cancels (the queue is empty after the fold).
- [x] GREEN: Preserve the progressive-Escape cancel path on the durable queue (the `justFolded` latch).
- [x] REFACTOR: Keep fold + cancel on one esc-action path; reuse the "steering" label (plan 31).

### M5 - Unqueue (supersede-no-replacement)

- [x] RED: Test that unqueuing one item emits a supersede-no-replacement; the host drops it from the run; catch-up excludes it after restart.
- [x] GREEN: Add the unqueue action + event wiring, sharing the supersede emit with the fold path.
- [x] RED: Test the narrow race - unqueuing an item the scheduler already attempted is a no-op (attempt-watermark), surfaced as running.
- [x] GREEN: Make unqueue a no-op for an attempted item (the scheduler's supersede skip only touches the queue, never the active turn).
- [x] REFACTOR: Deduplicate the fold and unqueue supersede emitters (both go through the one `supersede` session action).

### Gate 2-3

- [x] First Escape folds N durable queued prompts into one steering prompt via a single supersede event; second Escape cancels.
- [x] Unqueue retracts one prompt durably; a restarted host does not re-run a folded or unqueued prompt.
- [x] Supersede is a no-op for an already-attempted prompt.

### M6 - Recall ring (localStorage, capped, session-keyed)

- [x] RED: Unit test the capped recall-ring reducer - push, newest-first navigation, cap eviction, session-keyed pulled slice (existing `composer-storage.test.ts` / `use-prompt-history.test.tsx`).
- [x] GREEN: Implement the ring backed by `localStorage`, keyed by `sessionId`, capped (reused existing prompt-history primitive).
- [x] RED: Test the ring survives a reload and does not leak across sessions.
- [x] GREEN: Persist/restore from storage under the session key.
- [x] REFACTOR: Keep the ring a pure reducer behind a thin storage adapter (reusable project-keyed by the typed-history follow-on).

### M7 - Up/Down recall navigation + pull-into-composer

- [x] RED: Web test that Up at an empty composer pulls the newest queued item into the composer, emits a durable removal (M5 unqueue), and pushes it onto the recall ring; Up again navigates older, Down newer.
- [x] GREEN: Wire Up/Down to the ring + pull-newest (durable removal via `pullNewest`); re-submit re-enqueues durably.
- [x] RED: Test Up does NOT hijack the cursor in the multi-line full-surface editor - it recalls only at the composer-empty / first-line boundary.
- [x] GREEN: Gate the Up binding on the cursor boundary (`draft === "" && caretOnFirstLine`).
- [x] REFACTOR: Keep recall navigation and the durable removal cleanly separated.

### M8 - Rendering + observability + end-to-end

- [x] RED: Transcript/queue rendering test - durable queued (not-yet-run) and superseded/folded items render distinctly; artifacts survive replay (34) and the queue does not bleed into tangents (37).
- [x] GREEN: Render durable queued + superseded states (`queued-prompts.tsx` unqueue control + transcript suppression); hold the 34/37 invariants.
- [x] RED: Structured-event tests for queue publish / supersede(fold, unqueue) / drain / catch-up-run carrying superseded + replacement ids; queued-depth surfaces to telemetry/Doctor.
- [x] GREEN: Emit the observability (host `catch-up` + `supersede` structured logs); the scheduler `debug()` queued-depth already surfaces to /doctor.
- [x] RED: Hermetic e2e - queue 3 follow-ups, disconnect the client, assert the host drains all 3 in order; restart the host mid-backlog and assert in-order catch-up that excludes a folded/unqueued prompt.
- [x] GREEN: Make the e2e pass on the host + replay/restart harness (`turn-scheduler.test.ts` e2e + `follow-up-queue.test.ts`).
- [x] REFACTOR: Document the durable queue + supersession as the source of truth; Storybook states for queued / folded / superseded / recall.

### Done Gate

- [x] Follow-ups are durable events; a disconnected client's backlog still drains in order.
- [x] A host restart / standby takeover resumes the backlog in order from the log alone.
- [x] Supersession powers Escape-fold (N->1) and unqueue on the append-only log; catch-up runs only unanswered, not-superseded prompts.
- [x] Up/Down recall over a capped localStorage ring; pull-newest emits a durable removal; re-submit re-enqueues.
- [x] Up does not hijack the multi-line editor cursor.
- [x] 34 (artifact replay) and 37 (tangent isolation) invariants still pass.
- [x] Unit, integration, web, and hermetic e2e pass; observability for publish/supersede/drain/catch-up is in place.

## Accepted / Deferred Follow-Up

- Full Claude-Code typed-history parity (project-scoped, cross-session recall of every past prompt) - a follow-on plan; the recall ring is built reusable project-keyed.
- Per-item ownership / claim-lease - deliberately not built; pull-out emits an immediate durable removal instead.
- Roaming the recall buffer across devices - per-machine `localStorage` by design.
- Closing the browser security holes (auth, CORS, XSS, localStorage at rest) - tracked in `SECURITY_RISKS.md`, a separate pass.

## Superseded / Obsolete Checklist Debt

None.
