# Mid-Turn Model Switch - Implementation Plan

A single in-flight turn can change its model and/or reasoning level **between loop iterations**,
applied manually now and recorded as a first-class session event + transcript item. This is the
foundation the future auto-router (a separate, later plan) builds on; this plan only ships the manual
switch and the seam the router will attach to.

## 0. Hard Dependencies

- [x] Existing model/reasoning selection + chooser (umbrella D-065): `apps/web/src/hooks/use-model-selection.ts`, `packages/session/src/model-preferences.ts` (incl. `constrainReasoning`), `packages/session/src/model-source.ts` (`resolveUserTurnModel`).
- [x] Existing turn loop with an injected, immutable provider: `apps/agent-host/src/agent/loop.ts` (`runAgent`/`step`/`connectStep`/`afterModel`, `let currentReasoning`), `apps/agent-host/src/turn.ts` (`publishTurn`, `assistant.started`/`assistant.completed`), `apps/agent-host/src/main.ts` (`startTurn`, `handleEvent`).
- [x] Existing provider interface - `Provider.model` readonly, reasoning passed per call: `apps/agent-host/src/providers/types.ts`; `buildSourceProvider`/`pickProvider`.
- [x] Existing session-event protocol + transcript reducer: `packages/session/src/protocol.ts`, `packages/session/src/protocol-decode.ts` (`DecodedEvent`), `apps/web/src/transcript.ts`, `apps/web/src/components/chat/transcript-row-view.tsx`.
- [x] Existing usage/context-window measurement (`Usage { input, output, contextWindow }` in `@trevor/session`) reused by the Phase 3 guard - the guard depends on this contract, **not** on `.plans/32-context-pressure-meter` being complete.

## 1. Architecture

Today both V2 and V1 resolve model and reasoning **once per turn** and freeze them for the whole
agentic loop. In V2 `startTurn` builds an immutable `Provider` from the `user.message` payload
(`main.ts:515`), and `runAgent` captures `provider` (the argument) and seeds `let currentReasoning =
reasoning` once (`loop.ts:494`); every `step()` calls `provider.stream(conversation, tools,
currentReasoning)`. Nothing re-reads session state inside the loop, so a model/reasoning change made
while a turn is in flight is structurally a **next-turn** change (it only rides onto the next
`user.message`). There is no `model.*` event in the protocol at all.

This plan makes the loop re-resolve model + reasoning from a **mutable cell** at the step boundary,
routes an external switch request to the running turn's fiber, and records each switch as a new
session event + transcript item.

### The switch boundary

`runAgent` keeps a per-turn mutable cell of the active model + reasoning (an Effect `Ref` /
`SubscriptionRef`). There is exactly **one** re-resolution point: the start of each `step(n)`, before
`connectStep` opens a model stream. <!-- D-001 --> A switch never interrupts an in-flight
`provider.stream` call (one model request); it is observed only when the current step finishes and the
next begins. This single named boundary is also the seam the future auto-router and any later observer
attach to. <!-- D-004 -->

- **Reasoning-only change:** update the cell's reasoning; the same `Provider` is reused.
- **Model change:** rebuild the `Provider` from the new `ModelRef` (`buildSourceProvider`) because
  `Provider.model` is readonly, and clamp reasoning via `constrainReasoning` when the new model's
  support differs. <!-- D-002 -->

### Delivery and recording

A new **switch control event** carries the requested `ModelRef` + reasoning + `initiator`. The host's
`handleEvent` routes a request that arrives during an active turn to that turn's cell; if no turn is
active it is a no-op for the loop and the web simply keeps its next-turn selection (today's behavior).
On application (or refusal) the host emits one **`model.switched`** session event with `from`/`to`
`{model, reasoning}`, `initiator` (`manual` now, `auto` later), and `outcome` (`applied` | `blocked`),
recorded on the session log so replay reconstructs the active model at every point. <!-- D-003 --> The
web folds that event into a new transcript-item kind rendering `from <model>/<reasoning if changed> ->
<model>/<reasoning if changed>`, including reasoning-only changes.

### Stickiness

A switch made through the **UI selector** is sticky: it updates the in-flight turn's cell *and* the
persisted next-turn selection, so the model does not snap back when the turn ends. Programmatic /
non-UI stickiness (the auto-router) is handled later under its own mechanism. <!-- D-005 -->

### Context-window guard

Switching toward a **smaller** context window can overflow the conversation that grew under a larger
one. Only the larger->smaller direction is guarded; smaller->larger is always allowed. At the switch
boundary the guard compares current conversation tokens + response headroom (via the existing `Usage`
context-window measurement) against the **target** model's window. If it fits, the switch applies; if
not, v1 **refuses** the switch, leaves the active provider unchanged, and records `outcome: blocked`
with a user-visible reason in the transcript marker. Reduce-then-switch (compact, then retry) is a
deferred enhancement. <!-- D-007 -->

### Cross-model normalization

A cross-provider swap is the real hazard: provider A's assistant **thinking blocks** (e.g. extended-
thinking signatures) and **tool-call/tool-result encodings** may not replay on provider B. A
normalization pass at the cross-provider boundary strips/normalizes those so the carried conversation
is replayable on the new provider, and leaves a per-model system-prompt seam. This is high priority and
ships with full testing + observability in Phase 3. <!-- D-006 -->

### Key Constraints

| Constraint | Impact |
|---|---|
| Never interrupt an in-flight model request | The switch applies only at the next step boundary, never mid-stream <!-- D-001 --> |
| `Provider.model` is readonly | A model change rebuilds the `Provider`; a reasoning-only change does not <!-- D-002 --> |
| Cross-provider history must replay | The cross-provider phase normalizes provider-specific thinking blocks + tool-call encodings <!-- D-006 --> |
| Smaller context windows can overflow | Larger->smaller is guarded; v1 refuses a non-fitting switch with a recorded reason <!-- D-007 --> |
| Selection is browser-persisted today | A UI switch stays sticky by also updating the persisted selection <!-- D-005 --> |
| Reasoning support differs across models | Switching to a model with different support clamps reasoning at the host via `constrainReasoning` |

### Boundaries

| Boundary | Owns | Does not own |
|---|---|---|
| Per-turn switch cell (host) | The in-flight active model+reasoning truth; rebuild-on-model-change | The persisted next-turn selection (web) |
| `runAgent` step boundary | Re-reading the cell at step start; never mid-stream | Which model is chosen; provider construction policy |
| `model.switched` event | The from/to/initiator/outcome record on the session log | Rendering |
| transcript switch item | Inline from->to rendering, incl. reasoning-only and blocked | Event emission |
| Context-fit guard | The larger->smaller fit decision at switch time | The context-pressure meter UI (`.plans/32`) |
| Web chooser | Sending the switch when a turn is active + sticky persist; next-turn snapshot when idle | Host-side loop application |

### Observability

This touches runtime/provider/recovery behavior, so observability is first-class (Phase 3, M8):
structured switch events for `requested` / `applied` / `blocked` carrying from/to model+reasoning,
`initiator`, and the guard's context-fit numbers; a per-turn switch count surfaced where telemetry /
Doctor already report turn data; and the transcript marker as the user-visible inspection surface.
Tests drive switches through a fake multi-provider harness that asserts the model/reasoning the loop
uses on each step.

## 2. Phases

### Phase 1: Reasoning-only mid-turn switch (mechanism foundation)

**Goal:** A single turn can change reasoning between iterations, recorded as a `model.switched` event +
transcript marker, with the in-flight stream never interrupted and the UI switch sticky. No provider
rebuild yet.

#### M1: Switch cell + step-boundary re-read

- **Dependencies:** hard dependencies
- **Effort:** M
- **Tasks:**
  1. RED: Characterize current behavior - a reasoning change injected mid-loop is ignored because `runAgent` reads reasoning once (`loop.ts:494`); assert the failing expectation.
  2. GREEN: Introduce a per-turn mutable cell read at each `step(n)` start; a fake provider asserts the next step uses the cell's reasoning.
  3. RED: Add a test that a switch requested while a model stream is open does not interrupt it and is applied only at the next step boundary.
  4. GREEN: Read the cell only before `connectStep`, never mid-stream.
  5. REFACTOR: Name the single re-resolution boundary so later phases and the auto-router attach to one seam.

#### M2: Switch control event + host routing + `model.switched`

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Protocol tests for the new switch control event and the new `model.switched` session event (constructor + `DecodedEvent` member + decode).
  2. GREEN: Add `events.modelSwitched` + the control event; wire decode and lifecycle/inventory registration.
  3. RED: Host test that a switch request during an active turn updates the cell and emits `model.switched` (`initiator: manual`, `outcome: applied`); a request with no active turn is a loop no-op.
  4. GREEN: Route the request in `handleEvent` to the active turn's cell; emit the event.
  5. RED: Test a reasoning-only change records from/to reasoning with the model unchanged.
  6. GREEN: Emit from/to with an optional model delta.
  7. REFACTOR: Keep the request -> cell -> event path inspectable and redaction-safe.

#### M3: Transcript marker + sticky web send (reasoning)

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Transcript-reducer test folding `model.switched` into a new `modelSwitch` `Message` variant; row-view renders `from X (high) -> X (medium)`.
  2. GREEN: Add the `Message` variant + `toTranscript` case + `transcript-row-view` branch (+ grouping in `transcript-rows.ts`).
  3. RED: Web test that picking a reasoning level while a turn is active sends the switch event AND updates the persisted selection (sticky); when idle it only updates the selection (today's behavior).
  4. GREEN: Wire the chooser to turn-active state; send the switch when active, sticky-persist always.
  5. REFACTOR: Storybook states for the marker (reasoning-only, and placeholders for model-only / both / blocked).

### Gate 1->2

- [ ] A reasoning switch mid-turn works end to end: control event -> cell -> `model.switched` -> marker.
- [ ] An in-flight model stream is never interrupted by a switch.
- [ ] A UI switch is sticky (persisted selection updated); an idle switch behaves as today.

### Phase 2: Same-provider model swap

**Goal:** A turn can swap to a different model within the same provider/source between iterations, with
intra-provider history continuity, the event, marker, and sticky persistence.

#### M4: Rebuild provider on model change (same source)

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Test that a model change within the same source rebuilds the `Provider` and the next step uses the new model id.
  2. GREEN: Rebuild via `buildSourceProvider` when a model delta is present; clamp reasoning via `constrainReasoning` if the new model's support differs.
  3. RED: Test intra-provider conversation continuity - the carried conversation replays cleanly on the new model.
  4. GREEN: Carry the existing conversation array unchanged for same-provider swaps.
  5. REFACTOR: Separate provider-rebuild from cell-read so the cross-provider phase extends only the rebuild path.

#### M5: `model.switched` model delta + sticky model persist

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Event records from/to model; the marker shows the model change; the new model sticks for the next turn.
  2. GREEN: Implement the model-delta event + sticky model persistence.
  3. REFACTOR: Deduplicate the reasoning-only and model-change emit/marker paths.

### Gate 2->3

- [ ] Same-provider model swap works end to end with event + marker + sticky persistence.
- [ ] Carried history replays without corruption on the new same-provider model.

### Phase 3: Cross-provider swap + normalization + guard (full testing + observability)

**Goal:** A turn can swap across providers safely - prior thinking blocks and tool encodings are
normalized, the larger->smaller guard refuses unfitting switches, and the whole feature has full test
coverage and observability.

#### M6: Cross-model normalization

- **Dependencies:** M5
- **Effort:** L
- **Tasks:**
  1. RED: Tests that provider A's assistant thinking blocks / signatures are stripped or normalized so provider B can replay the carried conversation.
  2. GREEN: Apply a normalization pass at the cross-provider swap boundary.
  3. RED: Tests for tool-use id / tool-result encoding differences across providers.
  4. GREEN: Normalize tool-call/tool-result encodings for the target provider.
  5. REFACTOR: Keep normalization a pure, well-tested boundary; expose a per-model system-prompt seam.

#### M7: Larger->smaller context guard

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Fit-decision tests - smaller->larger always allowed; larger->smaller that fits allowed; that does not fit blocked with a reason.
  2. GREEN: Compute current conversation tokens + response headroom vs the target window (reuse the `Usage` measurement); refuse with a user-visible reason recorded on `model.switched` (`outcome: blocked`).
  3. RED: Test that a blocked switch renders in the marker and leaves the active provider unchanged.
  4. GREEN: Implement the blocked path with no provider mutation on refusal.
  5. REFACTOR: Keep the guard pure and reusable by the future auto-router.

#### M8: Observability + end-to-end

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Assert structured switch events (`requested` / `applied` / `blocked`) carry from/to model+reasoning, `initiator`, and context-fit numbers; a per-turn switch count is surfaced to telemetry/Doctor.
  2. GREEN: Emit the observability and surface the count where turn data already appears.
  3. RED: Hermetic e2e - one turn that switches reasoning, then same-provider model, then cross-provider, asserting markers + continuity, plus a blocked larger->smaller case.
  4. GREEN: Make the e2e pass on a fake multi-provider harness.
  5. REFACTOR: Document the switch boundary as the single seam the future auto-router attaches to.

### Done Gate

- [ ] All three switch kinds (reasoning, same-provider model, cross-provider model) work within one turn.
- [ ] A switch never interrupts an in-flight model request.
- [ ] A UI switch is sticky; an idle selection still rides the next `user.message`.
- [ ] The larger->smaller guard refuses unfitting switches predictably with a recorded reason.
- [ ] Cross-provider continuity is proven (thinking blocks + tool encodings normalized).
- [ ] Unit, integration, web, and hermetic e2e pass; observability for switch requested/applied/blocked is in place.

## 3. Non-Goals

- **The auto-router itself.** Heuristic/automatic model+reasoning routing is a separate later plan; this
  plan only builds the manual switch and the `initiator`/boundary seam it will reuse. <!-- D-004 -->
- **A plan-25 `ModelChange` hook.** Explicitly dropped; per-model prompt guidance, if pursued, belongs
  in the provider/catalog layer, not a user hook. <!-- D-004 -->
- **Programmatic / non-UI stickiness.** Deferred to the auto-router's own mechanism. <!-- D-005 -->
- **Reduce-then-switch on a blocked guard.** v1 refuses; compacting then switching is a later
  enhancement. <!-- D-007 -->

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---:|---:|---|
| Cross-provider history fails to replay (thinking signatures, tool encodings) | high | high | Dedicated normalization phase (M6) with full tests before cross-provider swap is allowed <!-- D-006 --> |
| Switching to a smaller window overflows mid-turn | high | medium | Larger->smaller guard refuses non-fitting switches; provider unchanged on block <!-- D-007 --> |
| Mutable cell introduces races with in-flight streams | medium | medium | Single re-resolution point at step start only; never mid-stream <!-- D-001 --> |
| "Current model" truth splits between cell and persisted selection | medium | medium | UI switch updates both (sticky); event on the session log is the replay source of truth <!-- D-003 --><!-- D-005 --> |
| Reasoning level invalid on the target model | medium | medium | Clamp via `constrainReasoning` at the host boundary on every switch |

## 5. Progress Report Accounting

Use `.plans/09.1-mid-turn-model-switch/progress-report.md` as the implementation resume state. Before
resuming implementation, run:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "09.1-mid-turn-model-switch"
```

## 6. Validation Commands

```bash
pnpm --filter @trevor/session test
pnpm --filter @trevor/agent-host test
pnpm --filter @trevor/web test -- --project web
pnpm --filter @trevor/web storybook
```

## 7. Decisions

Canonical decisions are in `.plans/09.1-mid-turn-model-switch/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "09.1-mid-turn-model-switch"
```

Key decisions referenced here use `<!-- D-NNN -->` markers.
