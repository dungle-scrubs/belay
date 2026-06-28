# Bounded Child + Takeover - Progress Report

## Summary

- **Current cutoff blockers:** 54
- **Completed current work:** 5
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - V1 and V2 Provenance Audit

## Completed Current State / Hard Dependencies

- [x] `.plans/28-tool-detail-takeover` defines the transcript-takeover pattern for inspecting deeper runtime/tool detail.
- [x] The umbrella subagent design defines isolated child sessions, depth limits, inline/background modes, durable child logs, and fold-back semantics.
- [x] `.plans/29-shell-promote-background-jobs` defines visible background-job inspection patterns that this plan should not duplicate.
- [x] `.plans/30-desktop-shell-tauri` defines future shell/supervisor boundaries that may affect escalation/takeover UX.
- [x] `.plans/44-local-admission-control` defines local model/runtime admission limits that bounded children must respect.

## Current Cutoff Blockers

### M1 - V1 and V2 Provenance Audit

- [ ] RED: Add a planning checklist that names every unresolved bounded-child/takeover question.
- [ ] GREEN: Inspect V1 references for H-024, H-025, and H-086 and summarize exact behavior/provenance.
- [ ] GREEN: Inspect current V2 subagent, takeover, tool-detail, and background-job plans/code for reuse boundaries.
- [ ] REFACTOR: Update this plan with clarified definitions and remove any speculative items that the audit disproves.

### M2 - Scope Cut and Contract Draft

- [ ] RED: Write acceptance criteria for the first bounded-child slice and explicitly out-of-scope variants.
- [ ] GREEN: Define initial child contract fields.
- [ ] RED: Define takeover acceptance criteria.
- [ ] GREEN: Update the plan DB with decisions for scope, takeover meaning, and mutation policy.
- [ ] REFACTOR: Split future directions into deferred follow-up rather than active blockers.

### Gate 1-2

- [ ] V1 H-024/H-025/H-086 provenance is summarized.
- [ ] The first bounded-child slice is explicitly scoped.
- [ ] Takeover semantics are decided.
- [ ] Mutating behavior is either excluded or guarded by named dependencies.

### M3 - Bounded Child Runtime

- [ ] RED: Add host tests for bounded child creation with explicit context and no implicit parent transcript.
- [ ] GREEN: Implement the minimal runtime path over the existing isolated child-session machinery.
- [ ] RED: Add tests for depth limits, tool allow-list enforcement, budget caps, and rejected delegation.
- [ ] GREEN: Return structured lifecycle and failure events for each bounded-child state.
- [ ] REFACTOR: Keep bounded-child policy separate from generic subagent execution.

### M4 - Structured Output and Fold-Back

- [ ] RED: Add tests for valid output, schema mismatch, partial output, and child failure.
- [ ] GREEN: Implement structured output validation and parent-visible folded result events.
- [ ] RED: Add cancellation and stale-child tests.
- [ ] GREEN: Ensure cancellation does not fold incomplete child output into the parent.
- [ ] REFACTOR: Keep parent transcript mutations explicit and auditable.

### Gate 2-3

- [ ] Runtime tests cover isolation, depth, tools, budgets, cancellation, and fold-back.
- [ ] Failure cases are structured and user-visible.
- [ ] No child can silently mutate or replace parent context.

### M5 - Storybook-First Takeover States

- [ ] RED: Add Storybook fixtures for running, completed, failed, canceled, escalated, stale, and fold-back-pending child states.
- [ ] GREEN: Build the takeover UI using the existing back-arrow/Escape transcript-takeover pattern.
- [ ] RED: Add interaction tests for back, Escape, cancel, fold/adopt, and unavailable child states.
- [ ] GREEN: Keep focus guards so takeover controls do not interact with the hidden parent transcript.
- [ ] REFACTOR: Share takeover primitives where appropriate without merging unrelated surfaces.

### M6 - Live Wiring and Inspection

- [ ] RED: Add web/host integration tests for opening a child takeover from parent transcript state.
- [ ] GREEN: Wire child lifecycle events into the takeover surface.
- [ ] RED: Add tests proving child details are visible but parent transcript is changed only through explicit fold/adopt action.
- [ ] GREEN: Wire fold/adopt/cancel actions through explicit host commands or protocol events.
- [ ] REFACTOR: Align visual density with tool-detail and archive/model chooser takeover patterns.

### Done Gate

- [ ] Discovery decisions are recorded and this plan no longer contains unresolved first-slice ambiguity.
- [ ] Runtime contract is tested for isolation, depth, tool limits, budgets, output validation, cancellation, and failure.
- [ ] Storybook covers takeover states before live app reliance.
- [ ] UI focus/back/Escape behavior is tested.
- [ ] Parent transcript mutation is explicit and auditable.
- [ ] Mutating bounded-child behavior remains deferred unless its dependencies are complete and approved.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
