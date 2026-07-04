# Subagent Variants - Progress Report

## Summary

- **Current cutoff blockers:** 0
- **Completed current work:** 7
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0 (M3 Teams + M4 Mutating Background Agents relocated to 21/46 - see below)
- **Current focus:** Done - all milestones landed

## Completed Current State / Hard Dependencies

- [x] D-045-D-049 define the existing subagent model.
- [x] The delegated-child leaf lives in `.plans/21-workflows-runtime` (bounded-child folded in; plan 12 dropped); 45 does not own it.
- [x] `.plans/01-managed-worktree-hardening` owns cwd lock hardening.
- [x] M1 Variant Rebaseline resolved: split decided (teams + mutating-bg engine -> `.plans/21-workflows-runtime`;
  mutating-worktree app -> `.plans/46-worktree-fleet`; verifier stays here).

### M2 - Verifier Subagent

- [x] RED: Independent adversarial review is covered without reviving inline self-validation - the verifier
  is a distinct delegated child (its own isolated context/session), read-only so it can never edit the work
  it judges (`discovery.test.ts` "the verifier is a read-only, independent adversarial reviewer with an
  explicit verdict"; `delegate.test.ts` "the verifier reviews in an isolated child ...").
- [x] GREEN: The `verifier` built-in agent variant lands in `subagents/discovery.ts` (D-003) and runs over
  the EXISTING delegation isolation (`agent/delegate.ts` `runDelegatedChild`) - a configured behavior, not a
  new mechanism. It is discovered, announced in `host.online`, and offered in the delegation inventory automatically.
- [x] REFACTOR: The verdict is explicit and parent-visible - the body demands a `VERDICT: PASS`/`VERDICT: FAIL`
  opening line, and the existing fold-back surfaces it to the parent BOTH as the `delegate_inline` result and
  as the terminal `delegated.to` event on the parent session.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

The M1 discovery split teams + mutating background agents out of this plan (see implementation.md
"Split (resolved in M1)"):

- ~~M3 Teams (bounded fan-out, aggregation, cancellation, progress visibility)~~ -> subsumed by
  `.plans/21-workflows-runtime`.
- ~~M4 Mutating Background Agents~~ -> engine-half to `.plans/21-workflows-runtime`, application-half to
  `.plans/46-worktree-fleet`.
</content>
</invoke>
