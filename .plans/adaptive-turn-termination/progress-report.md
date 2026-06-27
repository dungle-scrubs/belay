# Adaptive Turn Termination - Progress Report

**Status:** Planning complete, implementation not started.

## Current phase: Phase 1

First unchecked current-cutoff item: M1 DeepSeek-like low-context fixture.

## Summary

- Total checklist items: 51
- Completed: 0
- Remaining: 51
- Current focus: Phase 1, M1 session and event fixtures
- Current cutoff blockers: 51 unchecked implementation and verification items

## Phase 1: Characterize Current Failure

### M1: Session and event fixtures

- [ ] DeepSeek-like low-context fixture with 32 steps, 89,022 input tokens,
  1,000,000 context window, and `assistant.completed.stepLimit`
- [ ] High-context fixture that crosses the 80% pressure gate in fewer steps
- [ ] Repeated-tool fixture that represents a true loop stall
- [ ] Legacy completion fixture with `stepLimit` and no `stop` object
- [ ] Web characterization test showing the current UI cannot distinguish these
  cases

### M2: Current host behavior characterization

- [ ] Low-context 32-step fixture currently completes as a generic step-budget
  answer
- [ ] Context-pressure path currently has no typed cause
- [ ] `turn-termination.ts` currently can only report `step_limit`
- [ ] `/doctor` currently cannot explain why the run stopped

## Phase 2: Protocol and Pure Policy

### M3: Shared stop schema

- [ ] Protocol tests for `assistant.completed.stop` decode and encode
- [ ] `TurnStopCause`, `TurnStopAction`, and `TurnStop` schema added
- [ ] `stepLimit` remains optional and backward compatible
- [ ] Legacy events decode with no `stop` object
- [ ] Shared protocol source comments explain every stop cause

### M4: Pure termination evaluator

- [ ] Context pressure returns `context_pressure` and a synthesize action
- [ ] Low-context max-step backstop returns `step_backstop` and a pause action
- [ ] Repeated no-progress tool cycles return `loop_stalled`
- [ ] Provider diagnostics can return `provider_protocol_anomaly`
- [ ] Debug snapshots explain the selected cause and rejected alternatives

## Phase 3: Host Loop Integration

### M5: Loop actions

- [ ] Loop tests cover context-pressure synthesis
- [ ] Loop tests cover low-context step backstop pause
- [ ] Loop tests cover loop-stalled pause
- [ ] Direct `n >= MAX_STEPS || overContext` termination replaced with evaluator
  result
- [ ] Generic loop has no provider-specific string matching

### M6: Completion publication and host diagnostics

- [ ] `turn.ts` tests prove `assistant.completed.stop` is published
- [ ] `turn-termination.ts` precedence tests cover every stop cause
- [ ] Doctor snapshot tests cover latest non-answered stop
- [ ] Structured logs include stop cause and next action
- [ ] Old `stepLimit`-only events still render deterministically

## Phase 4: Web and Self-Documentation

### M7: Transcript rendering

- [ ] Transcript tests cover old `stepLimit` events
- [ ] Transcript tests cover every new host stop cause
- [ ] `PanelHost` tests cover context pressure, step backstop, loop stall, and
  provider anomaly copy
- [ ] Low-context step backstop renders as paused or stopped, not normal answer
  completion
- [ ] Diagnostic note rendering is bounded and layout-safe

### M8: Self-documenting surfaces

- [ ] `turn-policy.ts` module comment explains policy axes
- [ ] Shared protocol cause definitions have explanatory comments
- [ ] `/doctor` next-action text covers step backstop, context pressure, loop
  stall, provider anomaly, and overflow
- [ ] Canonical Trevor V2 plan has a short cross-reference to this plan
- [ ] Test and fixture names describe observed user-visible behaviors

## Phase 5: Full Verification

### M9: Integration and e2e fixtures

- [ ] Fake-provider integration or e2e run covers the DeepSeek-like 32-step, 9%
  context case
- [ ] Fake-provider run covers high-context pressure
- [ ] Provider-anomaly run is added once the provider diagnostics plan exposes
  the typed diagnostic shape
- [ ] Replay preserves stop cause and UI copy after refresh
- [ ] Fixtures are hermetic and independent of live DeepSeek

### M10: Release gates

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test:unit`
- [ ] `pnpm test:web`
- [ ] `pnpm test:integration`
- [ ] `pnpm test:e2e`
- [ ] Manual EZE replay check for prompt submission, refresh, and stop rendering
  on a local session

## Deferred Follow-Up

- [ ] Automatic multi-turn continuation after a pause
- [ ] Rich UI controls for continue, compress, retry, and cancel beyond the first
  necessary affordance
- [ ] Provider-specific anomaly classifiers for providers beyond DeepSeek/pi-ai
- [ ] Long-term metrics dashboards for stop causes across sessions
