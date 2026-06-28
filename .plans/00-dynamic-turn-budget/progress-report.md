# Dynamic Turn Budget - Progress Report

> Current focus: Complete - all phases implemented and validated.
> Source plan: [implementation.md](./implementation.md)

## Summary

- Completed: 35
- Remaining: 0
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0

## Current Cutoff

### Phase 1: Pure Budget Policy

#### M1: Budget Derivation Module

- [x] RED: Add `turn-budget.test.ts` cases for unknown context, small context, 128k, 512k, and 1M context tiers.
- [x] GREEN: Implement `deriveTurnBudget` in `turn-budget.ts`.
- [x] RED: Add tests for context pressure shrinking budget near the gate.
- [x] GREEN: Add pressure scaling.
- [x] RED: Add tests for repeated-tool and high-reasoning penalties.
- [x] GREEN: Add penalties while preserving a higher budget for 1M low-pressure turns.
- [x] REFACTOR: Keep constants named and documented so the heuristic is easy to tune.

#### M2: Emergency Ceiling Contract

- [x] RED: Add tests proving invalid or missing telemetry falls back to a conservative budget and never disables the ceiling.
- [x] GREEN: Return both `effectiveMaxSteps` and `emergencyMaxSteps`.
- [x] RED: Add tests proving the emergency ceiling is higher than the ordinary fallback but finite.
- [x] GREEN: Wire emergency metadata into the budget result.
- [x] REFACTOR: Make telemetry-quality classification explicit.

### Phase 2: Agent Loop Integration

#### M3: Replace Static `MAX_STEPS` Usage

- [x] RED: Update loop tests so a DeepSeek-like 1M context, low-pressure loop does not pause at 32.
- [x] GREEN: Compute `deriveTurnBudget` inside `step(n)` and pass `effectiveMaxSteps` into `evaluateTurnTermination`.
- [x] RED: Add a test that unknown context still pauses at the conservative fallback.
- [x] GREEN: Preserve fallback behavior for unknown usage.
- [x] REFACTOR: Rename `MAX_STEPS` to make any remaining hard cap clearly an emergency ceiling.

#### M4: Preserve Existing Stop Semantics

- [x] RED: Add tests proving context pressure still synthesizes before adaptive step budget exhaustion.
- [x] GREEN: Keep context pressure precedence in `evaluateTurnTermination`.
- [x] RED: Add tests proving repeated-tool stall still pauses before a generous context-derived budget.
- [x] GREEN: Preserve repeated-tool stall precedence.
- [x] REFACTOR: Keep `turn-policy.ts` focused on stop selection, not budget derivation.

### Phase 3: Diagnostics and UI Clarity

#### M5: Stop Summary and Debug Metadata

- [x] RED: Add host tests for stop summaries that mention the effective budget and reason without leaking raw internals.
- [x] GREEN: Extend stop summary construction with budget reason and key facts.
- [x] RED: Add debug-log or structured-event tests if the existing logging harness supports it.
- [x] GREEN: Emit budget factors through the existing debug path.
- [x] REFACTOR: Keep public stop text concise and put verbose facts in debug metadata.

### Phase 4: Validation

#### M7: Representative Fixture Matrix

- [x] RED: Add fixture tests for small local context, 128k cloud context, and 1M DeepSeek-like context.
- [x] GREEN: Ensure each fixture pauses or continues according to policy.
- [x] RED: Add a regression test for "1M context at 14% pressure does not stop at 32".
- [x] GREEN: Tune the heuristic if needed.
- [x] REFACTOR: Document tuning constants in `turn-budget.ts`.

#### M6: Web Regression Coverage

- [x] RED: Add or update web transcript tests for the new adaptive stop summary.
- [x] GREEN: Render the existing typed stop note without special-casing static wording.
- [x] REFACTOR: Avoid adding a new UI panel unless stop text proves insufficient.

## Notes

- `M5` debug-log assertion: the budget factors are emitted via `debug("agent", "turn-budget", ...)`
  in `loop.ts` (behind the verbose `agent` scope, off by default). The factor *contents* are
  covered directly by `turn-budget.test.ts` rather than by a brittle console capture; the stop
  *summary* carries the budget reason and is covered by `loop.test.ts` and `turn.test.ts`.
- `step_backstop` stays the cause name even though the budget is now adaptive: downstream consumers
  (`main.ts` auto-continue, `doctor/snapshot.ts` next-action) key off that cause and are unchanged.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
