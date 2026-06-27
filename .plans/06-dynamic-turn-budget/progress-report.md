# Dynamic Turn Budget - Progress Report

> Current focus: Phase 1 - Pure Budget Policy, M1 - Budget Derivation Module
> Source plan: [implementation.md](./implementation.md)

## Summary

- Completed: 0
- Remaining: 35
- Current cutoff blockers: 35
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0

## Current Cutoff

### Phase 1: Pure Budget Policy

#### M1: Budget Derivation Module

- [ ] RED: Add `turn-budget.test.ts` cases for unknown context, small context, 128k, 512k, and 1M context tiers.
- [ ] GREEN: Implement `deriveTurnBudget` in `turn-budget.ts`.
- [ ] RED: Add tests for context pressure shrinking budget near the gate.
- [ ] GREEN: Add pressure scaling.
- [ ] RED: Add tests for repeated-tool and high-reasoning penalties.
- [ ] GREEN: Add penalties while preserving a higher budget for 1M low-pressure turns.
- [ ] REFACTOR: Keep constants named and documented so the heuristic is easy to tune.

#### M2: Emergency Ceiling Contract

- [ ] RED: Add tests proving invalid or missing telemetry falls back to a conservative budget and never disables the ceiling.
- [ ] GREEN: Return both `effectiveMaxSteps` and `emergencyMaxSteps`.
- [ ] RED: Add tests proving the emergency ceiling is higher than the ordinary fallback but finite.
- [ ] GREEN: Wire emergency metadata into the budget result.
- [ ] REFACTOR: Make telemetry-quality classification explicit.

### Phase 2: Agent Loop Integration

#### M3: Replace Static `MAX_STEPS` Usage

- [ ] RED: Update loop tests so a DeepSeek-like 1M context, low-pressure loop does not pause at 32.
- [ ] GREEN: Compute `deriveTurnBudget` inside `step(n)` and pass `effectiveMaxSteps` into `evaluateTurnTermination`.
- [ ] RED: Add a test that unknown context still pauses at the conservative fallback.
- [ ] GREEN: Preserve fallback behavior for unknown usage.
- [ ] REFACTOR: Rename `MAX_STEPS` to make any remaining hard cap clearly an emergency ceiling.

#### M4: Preserve Existing Stop Semantics

- [ ] RED: Add tests proving context pressure still synthesizes before adaptive step budget exhaustion.
- [ ] GREEN: Keep context pressure precedence in `evaluateTurnTermination`.
- [ ] RED: Add tests proving repeated-tool stall still pauses before a generous context-derived budget.
- [ ] GREEN: Preserve repeated-tool stall precedence.
- [ ] REFACTOR: Keep `turn-policy.ts` focused on stop selection, not budget derivation.

### Phase 3: Diagnostics and UI Clarity

#### M5: Stop Summary and Debug Metadata

- [ ] RED: Add host tests for stop summaries that mention the effective budget and reason without leaking raw internals.
- [ ] GREEN: Extend stop summary construction with budget reason and key facts.
- [ ] RED: Add debug-log or structured-event tests if the existing logging harness supports it.
- [ ] GREEN: Emit budget factors through the existing debug path.
- [ ] REFACTOR: Keep public stop text concise and put verbose facts in debug metadata.

#### M6: Web Regression Coverage

- [ ] RED: Add or update web transcript tests for the new adaptive stop summary.
- [ ] GREEN: Render the existing typed stop note without special-casing static wording.
- [ ] REFACTOR: Avoid adding a new UI panel unless stop text proves insufficient.

### Phase 4: Validation

#### M7: Representative Fixture Matrix

- [ ] RED: Add fixture tests for small local context, 128k cloud context, and 1M DeepSeek-like context.
- [ ] GREEN: Ensure each fixture pauses or continues according to policy.
- [ ] RED: Add a regression test for "1M context at 14% pressure does not stop at 32".
- [ ] GREEN: Tune the heuristic if needed.
- [ ] REFACTOR: Document tuning constants in `turn-budget.ts`.

## Accepted/Deferred Follow-Up

None.

## Superseded/Obsolete Checklist Debt

None.
