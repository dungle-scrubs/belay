# Mid-Turn Model Switch - Progress Report

## Summary

- **Current cutoff blockers:** 51
- **Completed current work:** 0
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Switch cell + step-boundary re-read

## Completed Current State / Hard Dependencies

- [x] Model/reasoning selection + chooser (umbrella D-065): `apps/web/src/hooks/use-model-selection.ts`, `packages/session/src/model-preferences.ts` (`constrainReasoning`), `packages/session/src/model-source.ts` (`resolveUserTurnModel`).
- [x] Turn loop with an injected, immutable provider: `apps/agent-host/src/agent/loop.ts` (`runAgent`/`step`/`connectStep`/`afterModel`, `let currentReasoning`), `apps/agent-host/src/turn.ts`, `apps/agent-host/src/main.ts` (`startTurn`, `handleEvent`).
- [x] Provider interface - `Provider.model` readonly, reasoning per call: `apps/agent-host/src/providers/types.ts`; `buildSourceProvider`/`pickProvider`.
- [x] Session-event protocol + transcript reducer: `packages/session/src/protocol.ts`, `packages/session/src/protocol-decode.ts`, `apps/web/src/transcript.ts`, `apps/web/src/components/chat/transcript-row-view.tsx`.
- [x] Usage/context-window measurement (`Usage { input, output, contextWindow }`) for the Phase 3 guard - depends on this contract, not on `.plans/32` completion.

## Current Cutoff Blockers

### M1 - Switch cell + step-boundary re-read

- [x] RED: Characterize that a reasoning change injected mid-loop is ignored because `runAgent` reads reasoning once (`loop.ts:494`).
- [x] GREEN: Introduce a per-turn mutable cell read at each `step(n)` start; a fake provider asserts the next step uses the cell's reasoning.
- [x] RED: Test that a switch requested while a model stream is open does not interrupt it and applies only at the next step boundary.
- [x] GREEN: Read the cell only before `connectStep`, never mid-stream.
- [x] REFACTOR: Name the single re-resolution boundary so later phases and the auto-router attach to one seam.

### M2 - Switch control event + host routing + `model.switched`

- [x] RED: Protocol tests for the new switch control event and the new `model.switched` session event (constructor + `DecodedEvent` member + decode).
- [x] GREEN: Add `events.modelSwitched` + the control event; wire decode and lifecycle/inventory registration.
- [x] RED: Host test that a switch request during an active turn updates the cell and emits `model.switched` (`initiator: manual`, `outcome: applied`); a request with no active turn is a loop no-op.
- [x] GREEN: Route the request in `handleEvent` to the active turn's cell; emit the event.
- [x] RED: Test a reasoning-only change records from/to reasoning with the model unchanged.
- [x] GREEN: Emit from/to with an optional model delta.
- [x] REFACTOR: Keep the request -> cell -> event path inspectable and redaction-safe.

### M3 - Transcript marker + sticky web send (reasoning)

- [x] RED: Transcript-reducer test folding `model.switched` into a new `modelSwitch` `Message` variant; row-view renders `from X (high) -> X (medium)`.
- [x] GREEN: Add the `Message` variant + `toTranscript` case + `transcript-row-view` branch (+ grouping in `transcript-rows.ts`).
- [x] RED: Web test that picking a reasoning level while a turn is active sends the switch event AND updates the persisted selection (sticky); idle only updates the selection.
- [x] GREEN: Wire the chooser to turn-active state; send the switch when active, sticky-persist always.
- [x] REFACTOR: Storybook states for the marker (reasoning-only, plus placeholders for model-only / both / blocked).

### Gate 1-2

- [x] A reasoning switch mid-turn works end to end: control event -> cell -> `model.switched` -> marker.
- [x] An in-flight model stream is never interrupted by a switch.
- [x] A UI switch is sticky (persisted selection updated); an idle switch behaves as today.

### M4 - Rebuild provider on model change (same source)

- [x] RED: Test that a model change within the same source rebuilds the `Provider` and the next step uses the new model id.
- [x] GREEN: Rebuild via `buildSourceProvider` on a model delta; clamp reasoning via `constrainReasoning` if support differs.
- [x] RED: Test intra-provider conversation continuity - the carried conversation replays cleanly on the new model.
- [x] GREEN: Carry the existing conversation array unchanged for same-provider swaps.
- [x] REFACTOR: Separate provider-rebuild from cell-read so the cross-provider phase extends only the rebuild path.

### M5 - `model.switched` model delta + sticky model persist

- [x] RED: Event records from/to model; the marker shows the model change; the new model sticks for the next turn.
- [x] GREEN: Implement the model-delta event + sticky model persistence.
- [x] REFACTOR: Deduplicate the reasoning-only and model-change emit/marker paths.

### Gate 2-3

- [x] Same-provider model swap works end to end with event + marker + sticky persistence.
- [x] Carried history replays without corruption on the new same-provider model.

### M6 - Cross-model normalization

- [x] RED: Tests that provider A's assistant thinking blocks / signatures are stripped or normalized so provider B can replay the carried conversation.
- [x] GREEN: Apply a normalization pass at the cross-provider swap boundary.
- [x] RED: Tests for tool-use id / tool-result encoding differences across providers.
- [x] GREEN: Normalize tool-call/tool-result encodings for the target provider.
- [x] REFACTOR: Keep normalization a pure, well-tested boundary; expose a per-model system-prompt seam.

### M7 - Larger->smaller context guard

- [ ] RED: Fit-decision tests - smaller->larger always allowed; larger->smaller that fits allowed; that does not fit blocked with a reason.
- [ ] GREEN: Compute current conversation tokens + response headroom vs the target window (reuse `Usage`); refuse with a recorded reason on `model.switched` (`outcome: blocked`).
- [ ] RED: Test that a blocked switch renders in the marker and leaves the active provider unchanged.
- [ ] GREEN: Implement the blocked path with no provider mutation on refusal.
- [ ] REFACTOR: Keep the guard pure and reusable by the future auto-router.

### M8 - Observability + end-to-end

- [ ] RED: Assert structured switch events (`requested` / `applied` / `blocked`) carry from/to model+reasoning, `initiator`, and context-fit numbers; a per-turn switch count surfaces to telemetry/Doctor.
- [ ] GREEN: Emit the observability and surface the count where turn data already appears.
- [ ] RED: Hermetic e2e - one turn that switches reasoning, then same-provider model, then cross-provider, asserting markers + continuity, plus a blocked larger->smaller case.
- [ ] GREEN: Make the e2e pass on a fake multi-provider harness.
- [ ] REFACTOR: Document the switch boundary as the single seam the future auto-router attaches to.

### Done Gate

- [ ] All three switch kinds (reasoning, same-provider model, cross-provider model) work within one turn.
- [ ] A switch never interrupts an in-flight model request.
- [ ] A UI switch is sticky; an idle selection still rides the next `user.message`.
- [ ] The larger->smaller guard refuses unfitting switches predictably with a recorded reason.
- [ ] Cross-provider continuity is proven (thinking blocks + tool encodings normalized).
- [ ] Unit, integration, web, and hermetic e2e pass; observability for switch requested/applied/blocked is in place.

## Accepted / Deferred Follow-Up

- The auto-router (heuristic model+reasoning routing) - separate later plan; this plan ships the manual switch + `initiator`/boundary seam only.
- Programmatic / non-UI stickiness - deferred to the auto-router's own mechanism.
- Reduce-then-switch on a blocked guard - v1 refuses; compact-then-switch is a later enhancement.

## Superseded / Obsolete Checklist Debt

None.
