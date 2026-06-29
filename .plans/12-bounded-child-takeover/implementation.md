# Bounded Child + Takeover - Implementation Plan

## 0. Hard Dependencies

- [x] `.plans/08-tool-detail-takeover` defines the transcript-takeover pattern for inspecting deeper runtime/tool detail.
- [x] The umbrella subagent design (D-045-D-049 in `.plans/trevor-v2/implementation.md`) defines isolated child sessions, depth limits, inline/background modes, durable child logs, and fold-back semantics.
- [x] `.plans/09-shell-promote-background-jobs` defines visible background-job inspection patterns that this plan should not duplicate.
- [x] `.plans/10-desktop-shell-tauri` defines future shell/supervisor boundaries that may affect escalation/takeover UX.
- [x] `.plans/11-local-admission-control` defines local model/runtime admission limits that bounded children must respect.

## Disclaimer: Needs Further Fleshing Out

This is an extraction plan, not a fully settled design. The original umbrella backlog row only said:

> Bounded-child + takeover - H-024, H-025, H-086 - host-owned constrained helpers + route escalation/takeover

The plan below preserves that topic and turns it into reviewable work. The first phase is intentionally a discovery/rebaseline phase that must inspect V1 provenance, current V2 subagent behavior, and the already-extracted takeover plans before implementation starts. Do not treat the later milestones as final until M1 answers the open questions and updates this plan.

## Architecture

Bounded child is a constrained helper execution path: the host creates a child run/session with a narrow task contract, limited tools, explicit budgets, and structured output expectations. It differs from a general subagent because the host owns the constraint envelope and the expected return shape, rather than letting a broad agent freely decide how to proceed.

Takeover is the user-visible escalation path for cases where a bounded helper or child route cannot stay safely contained, needs direct user inspection, or should become the main interaction surface. It should reuse the transcript-takeover pattern from model chooser, archive browser, tangents, and tool detail: a top-left back affordance, Escape returns to chat, and the takeover surface makes the current object inspectable without mutating the parent transcript implicitly.

### Key Constraints

| Constraint | Impact |
|---|---|
| Bounded child is not a general-purpose subagent | It needs a tighter host-owned contract: allowed tools, budget, expected output shape, and escalation conditions. |
| Takeover is explicit | A child cannot silently replace the parent conversation; user-visible transition and back behavior are required. |
| Depth remains bounded | Reuse or extend the D-047 depth model; child-of-child behavior must stay disallowed unless a later plan changes that. |
| No hidden parent transcript access | Child input is explicit task/context only, matching D-048 isolation. |
| Mutating children need stronger prerequisites | Any mutating bounded child depends on managed worktrees, cwd locks, merge/reconcile semantics, and safety review. |
| Needs discovery before build | V1 H-024/H-025/H-086 behavior and current V2 subagent code must be inspected before finalizing scope. |

### Boundaries

- Subagent/session runtime owns child session creation, durable child logs, cancellation, fold-back, and depth enforcement.
- Bounded-child policy owns allowed tools, budgets, output schema, escalation criteria, and refusal/error shapes.
- Takeover UI owns inspection, focus/back behavior, route handoff, and user-visible transition states.
- Tool-detail takeover remains for inspecting a specific transcript item or running tool. Bounded-child takeover is for inspecting or adopting a child/helper route.
- Parent transcript receives only explicit artifacts: started/linked child event, final folded result, escalation request, or user-approved fold/adopt action.

### Observability

Bounded child and takeover behavior must be inspectable:

- child id, parent id, route/escalation reason, and budget caps
- tool allow-list and rejected-tool diagnostics
- child lifecycle events: queued, running, blocked, escalated, completed, canceled, failed
- structured failure payloads for budget exhaustion, schema mismatch, policy rejection, and takeover refusal
- user-visible detail/takeover view that shows what the child saw, what it did, and what will be folded back

## Open Questions

- What did H-024, H-025, and H-086 do in V1, exactly?
- Is "route escalation" model/provider escalation, agent escalation, UI takeover, or all three?
- Is takeover a read-only inspection surface, a way to continue chatting inside the child, or a way to promote the child into the main thread?
- What bounded-child templates should exist first, if any?
- Should bounded children always return typed artifacts, or can they return prose plus structured metadata?
- What user approval is required before fold-back, adoption, or mutation?

## Phases

### Phase 1: Discovery and Rebaseline

**Goal:** Turn the vague H-024/H-025/H-086 row into a concrete, owner-approved design.

**Gate from previous:** Hard dependencies are identified.

#### M1: V1 and V2 Provenance Audit

- **Dependencies:** Hard dependencies
- **Effort:** S
- **Tasks:**
  1. RED: Add a planning checklist that names every unresolved bounded-child/takeover question.
  2. GREEN: Inspect V1 references for H-024, H-025, and H-086 and summarize exact behavior/provenance.
  3. GREEN: Inspect current V2 subagent, takeover, tool-detail, and background-job plans/code for reuse boundaries.
  4. REFACTOR: Update this plan with clarified definitions and remove any speculative items that the audit disproves.

#### M2: Scope Cut and Contract Draft

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Write acceptance criteria for the first bounded-child slice and explicitly out-of-scope variants.
  2. GREEN: Define initial child contract fields: task, context, tools, budget, output shape, escalation policy, and fold-back behavior.
  3. RED: Define takeover acceptance criteria for open, inspect, back, Escape, fold/adopt, cancel, and stale child states.
  4. GREEN: Update the plan DB with decisions for scope, takeover meaning, and mutation policy.
  5. REFACTOR: Split future directions into deferred follow-up rather than active blockers.

### Gate 1-2

- [ ] V1 H-024/H-025/H-086 provenance is summarized.
- [ ] The first bounded-child slice is explicitly scoped.
- [ ] Takeover semantics are decided.
- [ ] Mutating behavior is either excluded or guarded by named dependencies.

### Phase 2: Runtime Contract

**Goal:** The host can create, run, observe, cancel, and reject bounded children according to a narrow contract.

#### M3: Bounded Child Runtime

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add host tests for bounded child creation with explicit context and no implicit parent transcript.
  2. GREEN: Implement the minimal runtime path over the existing isolated child-session machinery.
  3. RED: Add tests for depth limits, tool allow-list enforcement, budget caps, and rejected delegation.
  4. GREEN: Return structured lifecycle and failure events for each bounded-child state.
  5. REFACTOR: Keep bounded-child policy separate from generic subagent execution.

#### M4: Structured Output and Fold-Back

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add tests for valid output, schema mismatch, partial output, and child failure.
  2. GREEN: Implement structured output validation and parent-visible folded result events.
  3. RED: Add cancellation and stale-child tests.
  4. GREEN: Ensure cancellation does not fold incomplete child output into the parent.
  5. REFACTOR: Keep parent transcript mutations explicit and auditable.

### Gate 2-3

- [ ] Runtime tests cover isolation, depth, tools, budgets, cancellation, and fold-back.
- [ ] Failure cases are structured and user-visible.
- [ ] No child can silently mutate or replace parent context.

### Phase 3: Takeover UX

**Goal:** Users can inspect a bounded child or escalation route in a transcript-takeover surface without losing the parent chat.

#### M5: Storybook-First Takeover States

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook fixtures for running, completed, failed, canceled, escalated, stale, and fold-back-pending child states.
  2. GREEN: Build the takeover UI using the existing back-arrow/Escape transcript-takeover pattern.
  3. RED: Add interaction tests for back, Escape, cancel, fold/adopt, and unavailable child states.
  4. GREEN: Keep focus guards so takeover controls do not interact with the hidden parent transcript.
  5. REFACTOR: Share takeover primitives where appropriate without merging unrelated surfaces.

#### M6: Live Wiring and Inspection

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add web/host integration tests for opening a child takeover from parent transcript state.
  2. GREEN: Wire child lifecycle events into the takeover surface.
  3. RED: Add tests proving child details are visible but parent transcript is changed only through explicit fold/adopt action.
  4. GREEN: Wire fold/adopt/cancel actions through explicit host commands or protocol events.
  5. REFACTOR: Align visual density with tool-detail and archive/model chooser takeover patterns.

### Done Gate

- [ ] Discovery decisions are recorded and this plan no longer contains unresolved first-slice ambiguity.
- [ ] Runtime contract is tested for isolation, depth, tool limits, budgets, output validation, cancellation, and failure.
- [ ] Storybook covers takeover states before live app reliance.
- [ ] UI focus/back/Escape behavior is tested.
- [ ] Parent transcript mutation is explicit and auditable.
- [ ] Mutating bounded-child behavior remains deferred unless its dependencies are complete and approved.

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Bounded child duplicates generic subagents | high | medium | M1/M2 must define the distinct host-owned contract before implementation. | host |
| Takeover semantics stay vague | high | medium | Decide inspect/adopt/fold-back behavior before runtime wiring. | web + host |
| Child context leaks parent transcript | high | low | Tests must prove explicit-only context and no implicit prompt inheritance. | host |
| Mutating child creates workspace conflicts | high | medium | Keep mutation deferred behind managed worktrees, cwd locks, and merge/reconcile protocol. | host |
| UI takeover interferes with hidden parent transcript | medium | medium | Reuse focus guards and Escape/back tests from other takeover surfaces. | web |

## Escape Hatches

1. **If bounded-child scope collapses into generic subagents:** remove this plan's runtime work and keep only takeover/adoption behavior as an extension of subagents.
2. **If takeover is not needed for the first slice:** ship bounded-child runtime with transcript rows only, and defer takeover UI to a later plan update.
3. **If structured outputs are too broad:** start with one typed artifact shape and leave additional templates as deferred follow-up.

## Progress Report Accounting

This progress report starts with completed dependency accounting only. The feature itself is not implemented. M1/M2 are current blockers because the topic needs further fleshing out before implementation is safe.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "12-bounded-child-takeover"
```

## Validation Commands

```bash
pnpm test -- --project unit --run apps/agent-host/src
pnpm test -- --project web --run apps/web/src
pnpm storybook
```

## Decisions

Canonical decisions are in `.plans/12-bounded-child-takeover/plan.db`.
