# Dynamic Turn Budget RFC

## Problem

<!-- D-001 --> Trevor currently uses a static `MAX_STEPS = 32` as the hard runaway backstop for every provider and model. This value is not derived from the selected model, context window, tool behavior, reasoning level, or live progress.

The previous graceful-stop work made the backstop visible and prevented it from posing as a normal answer. It did not make the backstop adaptive. As a result, a large-context model such as DeepSeek V4 Pro can pause at low context pressure after exactly 32 steps even when there is still plenty of room and the agent may still be making useful progress.

## Goals

<!-- D-002 --> Replace the static step budget with a dynamic turn budget derived from model/runtime constraints and loop progress.

<!-- D-003 --> Keep a hard emergency ceiling so a broken loop cannot run forever when usage telemetry is missing, stale, or wrong.

<!-- D-004 --> Preserve the existing context-pressure stop as the primary room-based governor.

<!-- D-005 --> Make stop explanations user-visible and diagnostic enough to answer why a turn paused.

## Non-Goals

<!-- D-006 --> This plan does not add a new routing engine, model-led planner, or automatic task classifier.

<!-- D-007 --> This plan does not change provider streaming protocols except where additional local policy metadata is needed for stop diagnostics.

<!-- D-008 --> This plan does not remove manual cancel, stream stall protection, provider retry limits, or context overflow recovery.

## Proposed Approach

<!-- D-009 --> Add a pure turn-budget policy module that computes an effective step budget from the current provider/model, served context window, prompt pressure, reasoning level, recent tool progress, repeated-tool rounds, and telemetry availability.

<!-- D-010 --> The computed budget replaces `MAX_STEPS` as the ordinary step limit passed into `evaluateTurnTermination`.

<!-- D-011 --> A larger absolute emergency ceiling remains separate from the adaptive budget and is only used when policy inputs are invalid or the loop appears pathological.

<!-- D-012 --> Large-context models should receive more room while context pressure is low. Small-context or unknown-context models should remain conservative.

<!-- D-013 --> Repeated same-tool loops and no-progress patterns should reduce the effective budget sooner than healthy multi-tool exploration.

## Open Questions

<!-- D-014 --> The first implementation should use conservative local heuristics rather than adding a persisted per-model budget table. A per-model override table remains a future extension if measured behavior shows the heuristic is insufficient.

<!-- D-015 --> The UI should continue showing typed stop notes for adaptive pauses. A richer budget inspector can be added later if the basic stop note is not enough.

