# Subagent Variants - Progress Report

## Summary

- **Current cutoff blockers:** 3
- **Completed current work:** 4
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0 (M3 Teams + M4 Mutating Background Agents relocated to 21/46 - see below)
- **Current focus:** M2 - Verifier Subagent

## Completed Current State / Hard Dependencies

- [x] D-045-D-049 define the existing subagent model.
- [x] `.plans/12-bounded-child-takeover` owns bounded-child.
- [x] `.plans/01-managed-worktree-hardening` owns cwd lock hardening.
- [x] M1 Variant Rebaseline resolved: split decided (teams + mutating-bg engine -> `.plans/21-workflows-runtime`;
  mutating-worktree app -> `.plans/46-worktree-fleet`; verifier stays here).

## Current Cutoff Blockers

### M2 - Verifier Subagent

- [ ] RED: Cover independent adversarial review without reviving inline self-validation.
- [ ] GREEN: Add verifier agent behavior over existing subagent isolation.
- [ ] REFACTOR: Keep verifier output explicit and parent-visible.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

The M1 discovery split teams + mutating background agents out of this plan (see implementation.md
"Split (resolved in M1)"):

- ~~M3 Teams (bounded fan-out, aggregation, cancellation, progress visibility)~~ -> subsumed by
  `.plans/21-workflows-runtime`.
- ~~M4 Mutating Background Agents~~ -> engine-half to `.plans/21-workflows-runtime`, application-half to
  `.plans/46-worktree-fleet`.
