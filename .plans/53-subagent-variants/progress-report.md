# Subagent Variants - Progress Report

## Summary

- **Current cutoff blockers:** 12
- **Completed current work:** 3
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Variant Rebaseline

## Completed Current State / Hard Dependencies

- [x] D-045-D-049 define the existing subagent model.
- [x] `.plans/47-bounded-child-takeover` owns bounded-child.
- [x] `.plans/48-managed-worktree-hardening` owns cwd lock hardening.

## Current Cutoff Blockers

- [ ] RED: Define acceptance criteria and out-of-scope boundaries for verifier, teams, and mutating background agents.
- [ ] GREEN: Decide whether these remain one plan or split after discovery.
- [ ] REFACTOR: Update this plan with split/dependency decisions.
- [ ] RED: Cover independent adversarial review without reviving inline self-validation.
- [ ] GREEN: Add verifier agent behavior over existing subagent isolation.
- [ ] REFACTOR: Keep verifier output explicit and parent-visible.
- [ ] RED: Cover bounded fan-out, aggregation, cancellation, and progress visibility.
- [ ] GREEN: Implement multi-agent team orchestration if still approved.
- [ ] REFACTOR: Avoid multi-user/collaboration semantics.
- [ ] RED: Cover managed worktree/cwd-lock prerequisites, merge/reconcile requirements, and user approval.
- [ ] GREEN: Enable mutating background agents only behind completed safety gates.
- [ ] REFACTOR: Keep read-only background behavior unchanged.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
