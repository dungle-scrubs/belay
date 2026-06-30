# Durable Follow-Up Queue - Implementation Plan

Follow-up prompts submitted while a turn is in flight become **durable session events** the host
schedules, instead of browser-local state drip-fed one at a time. The backlog then survives the
submitting client disconnecting (and host restart / standby takeover), the host drains it in order,
and an Up-arrow **recall buffer** lets the user pull queued items back into the composer to edit. This
plan ships the queue-recall slice; full Claude-Code-style typed history is a follow-on. <!-- D-006 -->

## 0. Hard Dependencies

- [ ] **`.plans/09.1-mid-turn-model-switch` (forward dependency).** The durable queue drains the next
  follow-up at 09.1's **switch boundary** (the `step(n)` start re-resolution seam), and each queued
  item carries its model snapshot so it runs with the model selected when queued. 09.1 must land before
  the drain seam is finalized. <!-- D-008 -->
- [x] Shipped browser send queue (merged plan 07): `apps/web/src/send-queue.ts` (`QueuedPrompt`,
  `enqueue`/`drainHead`/`steer`/`clear`, `foldSteer`/`foldQueuedSteer`), `apps/web/src/hooks/use-send-queue.ts`
  (busy-gated drain effect), `apps/web/src/esc-action.ts` (progressive Escape), `apps/web/src/components/chat/queued-prompts.tsx`.
- [x] Host turn scheduler + catch-up: `apps/agent-host/src/agent/turn-scheduler.ts` (`submit`/`drain`/`processCompletion`,
  `pendingCatchUp`, `isAnswerablePrompt`, `lastStartSeq` attempt-watermark), wired in `apps/agent-host/src/main.ts`
  (`noteTurn`, `onBecomeLeader`, `goLive`, `reapOrphans`).
- [x] History projection collapse: `apps/agent-host/src/agent/history-projection.ts` (`pushUser` collapses
  consecutive user turns to the latest) - the behavior Phase 1 must scope so it no longer eats queued follow-ups.
- [x] `user.message` event shape with a stable `eventId` + ordered `seq`: `packages/session/src/event.ts`
  (`SessionEvent`), `packages/session/src/protocol.ts` (`events.userMessage`, carrying `text`/`provider`/`reasoning`/`model`/`artifacts`/`pastes`), `packages/session/src/protocol-decode.ts`.
- [x] Per-item model snapshot already on `QueuedPrompt` (umbrella D-065): `apps/web/src/send-queue.ts` snapshots `provider`/`reasoning`/`model` at submit.
- [x] Compatibility anchors held by tests, not changed here: `.plans/34-transcript-image-rendering` (queued/steered prompts preserve artifacts through replay), `.plans/37-tangents` (parent send queue must not bleed into tangent state), `.plans/31-action-shimmer-status` (the "steering" status label).
- [ ] **Reorg (plan 22.2):** Plan 22.2 decomposes main.ts: the leader/turn wiring functions this plan edits (noteTurn, onBecomeLeader, goLive, reapOrphans) relocate out of main.ts (the composition root keeps a visible routing table; handler bodies move to events/). agent/turn-scheduler.ts and agent/history-projection.ts do NOT move. Target the post-22.2 wiring locations. <!-- D-009 -->

## 1. Architecture

Today the send queue is **browser React state** (`use-send-queue.ts`): a prompt submitted while a turn
is in flight waits in a `useReducer` array and the busy-gated drain effect publishes the head as a
`user.message` only once the turn frees, one at a time. So the browser is the scheduler, and the
un-drained backlog lives only in the tab - it is lost when the tab closes (`inventory.ts` notes queued
work is not durable). The host already has most of the runtime: `TurnScheduler.submit` defers a
mid-turn `user.message` behind the active turn and `drain` runs it after, but its queue is **in-memory**,
catch-up resurrects only the **latest** unanswered prompt (`pendingCatchUp`), and the history projection
**collapses** consecutive user turns to the latest (`history-projection.ts`). So a stack of follow-ups
is not preserved as an ordered, individually-answerable durable queue.

This plan moves the queue into the durable log: each follow-up is **published at submit time** (not
withheld), the host owns scheduling through the existing `TurnScheduler`, and catch-up + the projection
are extended from "latest unanswered" to "all unanswered **and not superseded**, in `seq` order." A new
**supersession** event (the first event-to-event reference in the protocol) lets the existing
Escape-fold collapse N queued prompts into one and lets the user unqueue an item, both on the
append-only log. A local **recall buffer** (localStorage) holds pulled-out and past prompts for editing.

### Durable queue (publish at submit)

A follow-up is published immediately as a `user.message`, carrying its model snapshot (D-065). The
browser stops withholding and drip-feeding; the host's `TurnScheduler` defers it behind the active turn
and drains it at the next step boundary (09.1's seam). The `useSendQueue` busy/in-flight drain-latch
machinery is retired - serialization moves to the host, which already runs one turn at a time.
<!-- D-001 -->

### Multi-prompt in-order catch-up

`pendingCatchUp` changes from returning the single latest unanswered prompt to draining **all**
unanswered, not-superseded `user.message`s in `seq` order. The consecutive-user collapse in
`history-projection.ts` is scoped to the **abandoned-turn** case (an unanswered prompt with no following
queue) so it no longer eats deliberately-queued follow-ups, which stay distinct ordered turns. The
`lastStartSeq` attempt-watermark and orphan reap are preserved, so an attempted-then-orphaned prompt is
still **not** auto-re-run (no restart loop). <!-- D-002 -->

### Supersession (the first event-to-event reference)

A new supersede event names one or more prior `user.message` `eventId`s as retracted, with an **optional
replacement** prompt. The catch-up predicate and projection treat a superseded message as not-to-run:
the durable-log equivalent of removing it from the queue, since the log is append-only and never
mutated. Two producers: Escape-fold (supersede N **with** a folded replacement) and unqueue (supersede
one **with no** replacement). <!-- D-003 -->

### Escape semantics preserved

First Escape still folds the durable queue into **one** steering prompt - now a supersede-with-replacement
event instead of clearing local state - and the host runs the folded prompt after the active turn.
Second Escape still cancels (the queue is empty after the fold). The "steering" label is reused from
plan 31. <!-- D-007 -->

### Recall buffer (local, no per-item ownership)

Up-arrow pulls the **newest** queued item into the composer. Pulling **emits an immediate durable
removal** (a supersede-no-replacement), so the host can no longer run it - which means there is **no
edit-vs-run race and no per-item claim-lease**. The pulled item is pushed onto a local recall ring in
`localStorage`, navigated with Up/Down; re-submit re-enqueues it durably. The ring is capped and keyed
by `sessionId` for pulled items. The cost of dropping ownership is an accepted window: a pulled item is
**local-only until re-submitted**, so it is lost if that browser dies first, and the ring does not roam
across machines. The "walk away and it keeps running" guarantee covers the queue you **leave alone**,
not items pulled into the recall buffer. <!-- D-004 --> <!-- D-005 -->

### Multi-host / restart

A restarted or standby leader re-derives the queue purely from the durable log (all unanswered,
not-superseded, in order), so the backlog survives client death and host failover with no in-memory
state. This is what makes the feature's durability real rather than cosmetic.

### Key Constraints

| Constraint | Impact |
|---|---|
| Browser must stop being the scheduler | Follow-ups publish at submit; the host's `TurnScheduler` owns ordering; the drain-latch is retired <!-- D-001 --> |
| Append-only log, never mutated | "Remove from queue" is a supersede event, not a delete <!-- D-003 --> |
| Catch-up was latest-only + collapse | Extended to all-unanswered-and-not-superseded in `seq` order; collapse scoped to the abandoned-turn case <!-- D-002 --> |
| No per-item ownership | Pull-out emits an immediate durable removal, sidestepping the edit-vs-run race instead of leasing <!-- D-004 --> |
| Pulled items are local-only | They live in `localStorage` until re-submitted (accepted loss window, no cross-device roam) <!-- D-005 --> |
| Each queued item snapshots its model (D-065) | Drains at 09.1's switch boundary with the model selected when queued <!-- D-008 --> |
| Attempted-then-orphaned must not loop | The `lastStartSeq` watermark + orphan reap are preserved; supersede is a no-op for an attempted item |

### Boundaries

| Boundary | Owns | Does not own |
|---|---|---|
| Durable queue (host) | scheduling + ordering of unanswered `user.message`s | the composer draft, the recall buffer |
| Supersession event | the superseded-ids + optional-replacement record on the log | rendering |
| Catch-up + projection | which unanswered, not-superseded prompts run, in `seq` order | the local recall ring |
| Recall buffer (web, localStorage) | local edit history of pulled/past prompts; Up/Down navigation | durable queue membership |
| Escape-fold (esc-action) | first-Escape collapse to one steering prompt via supersede | second-Escape cancel |
| Web submit path | publishing each follow-up immediately + the model snapshot | host-side scheduling/drain |

### Observability

This touches runtime/recovery/transport behavior, so observability is first-class (Phase 3, M8):
structured events for queue **publish**, **supersede** (fold vs unqueue, carrying superseded ids +
optional replacement), **drain**, and **catch-up-run**; a queued-depth surfaced where turn telemetry /
Doctor already report turn data; and the transcript as the user-visible inspection surface, rendering
not-yet-run durable follow-ups and superseded/folded items distinctly. Tests drive the queue through
the host scheduler and a replay/restart harness asserting all-in-order catch-up and supersede exclusion.

## 2. Phases

### Phase 1: Durable publish + in-order catch-up

**Goal:** Follow-ups are durable events the host drains in order; the backlog survives client
disconnect and host restart. No supersession or recall UI yet.

**Gate from previous:** hard dependencies in place; 09.1's switch boundary available for the drain seam
(or a clearly-marked interim drain point pending 09.1).

#### M1: Publish follow-ups at submit (host owns scheduling)

- **Dependencies:** hard dependencies
- **Effort:** M
- **Tasks:**
  1. RED: Characterize the current drip-feed - a second follow-up submitted mid-turn is withheld in `useSendQueue` and absent from the durable log until the active turn completes; assert that failing expectation.
  2. GREEN: Publish each follow-up as a `user.message` at submit time, carrying its model snapshot (D-065); the host's `TurnScheduler.submit` defers it behind the active turn.
  3. RED: Test that after queuing N follow-ups and disconnecting the browser, all N are on the durable log and the host drains them.
  4. GREEN: Retire the browser busy-gated drain/in-flight latch; submit becomes a thin immediate-publish path.
  5. REFACTOR: Remove the now-dead drain/latch machinery from `useSendQueue`; keep the queue read model the panel renders sourced from the log.

#### M2: Multi-prompt in-order catch-up + scoped projection collapse

- **Dependencies:** M1
- **Effort:** L
- **Tasks:**
  1. RED: Host test that with N unanswered follow-ups in the log, a started/standby leader runs ALL of them in `seq` order, not just the latest (`pendingCatchUp` returns only the latest today).
  2. GREEN: Extend catch-up to drain all unanswered prompts in order via the existing scheduler.
  3. RED: Test that `history-projection.ts` no longer collapses queued durable follow-ups into the latest, while still collapsing the abandoned-turn (unanswered, no queue) case.
  4. GREEN: Scope the consecutive-user collapse to the abandoned-turn case; queued follow-ups stay distinct ordered turns.
  5. RED: Test the attempt-watermark still prevents re-running an attempted-then-orphaned prompt (no restart loop).
  6. GREEN: Preserve the `lastStartSeq` / orphan-reap interaction under multi-prompt catch-up.
  7. REFACTOR: Keep catch-up + projection one tested ordering rule with a single "answerable and not superseded" predicate seam (supersession lands in M3).

### Gate 1->2

- [ ] N follow-ups queued then client disconnected: the host drains all N, in order, with no client connected.
- [ ] A host restart mid-backlog resumes draining the remaining unanswered prompts in order.
- [ ] An attempted-then-orphaned prompt is not re-run; no restart loop.

### Phase 2: Supersession + Escape-fold + unqueue

**Goal:** A supersede event retracts or replaces queued prompts on the append-only log; the existing
Escape-fold and a new unqueue both work durably; catch-up excludes superseded prompts.

**Gate from previous:** durable in-order catch-up works and is the single ordering rule.

#### M3: Supersession event + exclusion predicate

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Protocol tests for a supersede event carrying superseded `eventId`s + an optional replacement (constructor + `DecodedEvent` member + decode).
  2. GREEN: Add the supersede event + decode + lifecycle/inventory registration.
  3. RED: Test catch-up + projection treat a superseded `user.message` as not-to-run ("unanswered AND not superseded"), including after restart.
  4. GREEN: Apply supersession in the catch-up predicate and the projection fold.
  5. REFACTOR: Keep supersession a pure fold over the log; name the predicate seam so fold and unqueue share it.

#### M4: Escape-fold as supersede-with-replacement

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Web + host test that first Escape with N durable queued prompts emits ONE supersede-with-replacement (N superseded, one folded steering prompt published); the host runs the folded prompt after the active turn; the transcript shows the fold, not N runs.
  2. GREEN: Reroute `foldQueuedSteer` / first-Escape in `esc-action.ts` to publish the supersede+replacement instead of clearing local state.
  3. RED: Test second Escape still cancels (the queue is empty after the fold).
  4. GREEN: Preserve the progressive-Escape cancel path on the durable queue.
  5. REFACTOR: Keep fold + cancel on one esc-action path; reuse the "steering" label (plan 31).

#### M5: Unqueue (supersede-no-replacement)

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Test that unqueuing one item emits a supersede-no-replacement; the host drops it from the run; catch-up excludes it after restart.
  2. GREEN: Add the unqueue action + event wiring, sharing the supersede emit with the fold path.
  3. RED: Test the narrow race - unqueuing an item the scheduler already attempted is a no-op (attempt-watermark), surfaced as running rather than yanked.
  4. GREEN: Make unqueue a no-op for an attempted item.
  5. REFACTOR: Deduplicate the fold and unqueue supersede emitters.

### Gate 2->3

- [ ] First Escape folds N durable queued prompts into one steering prompt via a single supersede event; second Escape cancels.
- [ ] Unqueue retracts one prompt durably; a restarted host does not re-run a folded or unqueued prompt.
- [ ] Supersede is a no-op for an already-attempted prompt.

### Phase 3: Local recall buffer + UX + observability

**Goal:** Up/Down recall navigation over a capped localStorage ring, pull-newest-into-composer
(durable removal), re-submit re-enqueues, plus rendering, observability, and end-to-end coverage.

**Gate from previous:** supersession and unqueue work durably.

#### M6: Recall ring (localStorage, capped, session-keyed)

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Unit test the capped recall-ring reducer - push, newest-first navigation, cap eviction, session-keyed pulled slice.
  2. GREEN: Implement the ring backed by `localStorage`, keyed by `sessionId` for the pulled slice, capped.
  3. RED: Test the ring survives a reload and does not leak across sessions.
  4. GREEN: Persist/restore from `localStorage` under the session key.
  5. REFACTOR: Keep the ring a pure reducer behind a thin `localStorage` adapter (so the typed-history follow-on can reuse it project-keyed).

#### M7: Up/Down recall navigation + pull-into-composer

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Web test that Up at an empty composer pulls the newest queued item into the composer, emits a durable removal (M5 unqueue), and pushes it onto the recall ring; Up again navigates older, Down newer.
  2. GREEN: Wire Up/Down to the ring + pull-newest (durable removal); re-submit re-enqueues durably (immediate publish from M1).
  3. RED: Test Up does NOT hijack the cursor in the multi-line full-surface editor - it recalls only at the composer-empty / first-line boundary.
  4. GREEN: Gate the Up binding on the cursor boundary.
  5. REFACTOR: Keep recall navigation and the durable removal cleanly separated so neither owns the other's state.

#### M8: Rendering + observability + end-to-end

- **Dependencies:** M7
- **Effort:** L
- **Tasks:**
  1. RED: Transcript/queue rendering test - durable queued (not-yet-run) follow-ups and superseded/folded items render distinctly; artifacts survive replay (34) and the queue does not bleed into tangents (37).
  2. GREEN: Render durable queued + superseded states; hold the 34/37 invariants.
  3. RED: Structured-event tests for queue publish / supersede(fold, unqueue) / drain / catch-up-run carrying superseded + replacement ids; a queued-depth surfaces to telemetry/Doctor.
  4. GREEN: Emit the observability and surface queued-depth where turn data already appears.
  5. RED: Hermetic e2e - queue 3 follow-ups, disconnect the client, assert the host drains all 3 in order; restart the host mid-backlog and assert in-order catch-up that excludes a folded/unqueued prompt.
  6. GREEN: Make the e2e pass on the host + replay/restart harness.
  7. REFACTOR: Document the durable queue + supersession as the source of truth; Storybook states for queued / folded / superseded / recall.

### Done Gate

- [ ] Follow-ups are durable events; a disconnected client's backlog still drains in order.
- [ ] A host restart / standby takeover resumes the backlog in order from the log alone.
- [ ] Supersession powers Escape-fold (N->1) and unqueue on the append-only log; catch-up runs only unanswered, not-superseded prompts.
- [ ] Up/Down recall over a capped localStorage ring; pull-newest emits a durable removal; re-submit re-enqueues.
- [ ] Up does not hijack the multi-line editor cursor.
- [ ] 34 (artifact replay) and 37 (tangent isolation) invariants still pass.
- [ ] Unit, integration, web, and hermetic e2e pass; observability for publish/supersede/drain/catch-up is in place.

## 3. Non-Goals

- **Full Claude-Code typed-history parity.** Project-scoped, cross-session recall of every past
  submitted prompt is a follow-on plan; this plan ships the queue-recall slice and a ring built to be
  reused project-keyed later. <!-- D-006 -->
- **Per-item ownership / claim-lease.** Deliberately not built; pull-out emits an immediate durable
  removal instead, accepting the local-only window. <!-- D-004 -->
- **Roaming the recall buffer across devices.** It is per-machine `localStorage` by design. <!-- D-005 -->
- **Closing the browser security holes** (no auth, permissive CORS, XSS surface, localStorage at rest).
  Tracked in `SECURITY_RISKS.md`; a separate pass. This plan does no harm only: caps the ring, offers a
  clear-recall-history control, and keeps secret-shaped content out of it. <!-- D-008 -->

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---:|---:|---|
| A pulled-out item is lost if the browser dies before re-submit | medium | medium | Accepted - pulling-to-edit is at-the-keyboard; the durability guarantee covers the untouched queue, not the recall buffer <!-- D-004 --> |
| Multi-prompt catch-up re-runs a superseded prompt after restart | high | low | Catch-up predicate is "unanswered AND not superseded"; restart re-derives from the log <!-- D-002 --><!-- D-003 --> |
| Scoping the consecutive-user collapse breaks abandoned-turn assembly | medium | medium | Collapse still applies to the unanswered-without-queue case; both paths tested in M2 |
| Unqueue/cancel races the scheduler picking up the head as a turn ends | medium | low | Supersede is a no-op for an attempted prompt (attempt-watermark); UI shows it as running <!-- D-003 --> |
| Tangent isolation (37) or artifact replay (34) regress under a durable queue | medium | medium | Keep the durable queue session-scoped; preserve artifact-through-replay; M8 guards both |
| Drain seam lands before 09.1's switch boundary exists | medium | medium | Phase 1 uses an interim drain point clearly marked; finalize on 09.1's seam <!-- D-008 --> |

## 5. Progress Report Accounting

Use `.plans/47-durable-follow-up-queue/progress-report.md` as the implementation resume state. Before
resuming implementation, run:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "47-durable-follow-up-queue"
```

## 6. Validation Commands

```bash
pnpm --filter @trevor/session test
pnpm --filter @trevor/agent-host test
pnpm --filter @trevor/web test -- --project web
pnpm --filter @trevor/web storybook
```

## 7. Decisions

Canonical decisions are in `.plans/47-durable-follow-up-queue/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "47-durable-follow-up-queue"
```

Key decisions referenced here use `<!-- D-NNN -->` markers.
