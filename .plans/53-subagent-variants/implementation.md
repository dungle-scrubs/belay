# Subagent Variants - Implementation Plan

## 0. Hard Dependencies

- [x] D-045-D-049 define the existing general-purpose, explorer, inline/background read-only, isolated-session, and ephemeral-agent model.
- [x] `.plans/47-bounded-child-takeover` now owns bounded-child.
- [x] `.plans/48-managed-worktree-hardening` owns cwd lock hardening needed before mutating background agents.

## Scope

Extracted from H-165. This plan owns the remaining parked subagent variants only: verifier subagent, teams/multi-agent fan-out, and mutating background agents. It does not reopen shipped general-purpose/explorer/ephemeral definitions, and it does not own bounded-child.

## Phases

### M1 - Variant Rebaseline

- [ ] RED: Define acceptance criteria and out-of-scope boundaries for verifier, teams, and mutating background agents.
- [ ] GREEN: Decide whether these remain one plan or split after discovery.
- [ ] REFACTOR: Update this plan with any split/dependency decisions.

### M2 - Verifier Subagent

- [ ] RED: Cover independent adversarial review without reviving inline self-validation.
- [ ] GREEN: Add verifier agent behavior over existing subagent isolation.
- [ ] REFACTOR: Keep verifier output explicit and parent-visible.

### M3 - Teams

- [ ] RED: Cover bounded fan-out, aggregation, cancellation, and progress visibility.
- [ ] GREEN: Implement multi-agent team orchestration if still approved.
- [ ] REFACTOR: Avoid multi-user/collaboration semantics.

### M4 - Mutating Background Agents

- [ ] RED: Cover managed worktree/cwd-lock prerequisites, merge/reconcile requirements, and user approval.
- [ ] GREEN: Enable mutating background agents only behind completed safety gates.
- [ ] REFACTOR: Keep read-only background behavior unchanged.

## Decisions

Canonical decisions are in `.plans/53-subagent-variants/plan.db`.
