# Subagent Variants - Implementation Plan

## 0. Hard Dependencies

- [x] D-045-D-049 define the existing general-purpose, explorer, inline/background read-only, isolated-session, and ephemeral-agent model.
- [x] `.plans/12-bounded-child-takeover` now owns bounded-child.
- [x] `.plans/01-managed-worktree-hardening` owns cwd lock hardening needed before mutating background agents.

## Scope

Extracted from H-165. After the M1 discovery, this plan owns the **verifier subagent only**.
Teams/multi-agent fan-out and the mutating-background-agent **engine** were split out to
`.plans/21-workflows-runtime`, and the mutating-worktree **application** (merge/reconcile/approval) to
`.plans/46-worktree-fleet`. This plan does not reopen shipped general-purpose/explorer/ephemeral
definitions, and it does not own bounded-child.

## Phases

### M1 - Variant Rebaseline (resolved)

- [x] RED: Acceptance criteria and out-of-scope boundaries defined for verifier, teams, and mutating
  background agents.
- [x] GREEN: Decided to **split** - teams + the mutating-background engine move to
  `.plans/21-workflows-runtime`; the mutating-worktree application moves to `.plans/46-worktree-fleet`;
  the verifier stays here.
- [x] REFACTOR: Plan updated - M3 (Teams) and M4 (Mutating Background Agents) removed; see Split below.

### M2 - Verifier Subagent

- [ ] RED: Cover independent adversarial review without reviving inline self-validation.
- [ ] GREEN: Add verifier agent behavior over existing subagent isolation.
- [ ] REFACTOR: Keep verifier output explicit and parent-visible.

## Split (resolved in M1)

The discovery concluded that "teams" and "mutating background agents" are the same orchestration
pattern as a general workflows engine, and were split out:

- **Teams (former M3)** - bounded fan-out, aggregation, cancellation, progress visibility - is
  **subsumed entirely by `.plans/21-workflows-runtime`** (it *is* the engine). The "teams" noun is
  retired: it collides with the permanently dropped multi-user "teams" (umbrella §4, D-003). The
  orchestration nouns are **workflow** (engine) and **fleet** (the `.plans/46-worktree-fleet` application).
- **Mutating background agents (former M4)** split in two: the **engine-half** (worktree-isolated,
  write-capable leaves) is in **`.plans/21-workflows-runtime`**; the **application-half** (merge/reconcile/approval
  around N concurrent mutating trees) is in **`.plans/46-worktree-fleet`**.

The verifier (M2) stays here: it is distinct from the dropped inline self-validation (umbrella §4,
D-033) and is reused by `.plans/46-worktree-fleet` as the per-tree auditor leaf.

## Decisions

Canonical decisions are in `.plans/45-subagent-variants/plan.db`.
