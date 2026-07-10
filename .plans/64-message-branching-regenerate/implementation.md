# Message Branching + Regenerate - Implementation Plan (stub)

> **Status: intentionally light.** Parks the one genuine capability gap from the 58.6
> audit. Needs a design pass before milestones. <!-- D-001 -->

## 0. Hard Dependencies

- [ ] OPEN: relationship to Trevor's existing tangent sessions
  (`packages/session/src/tangent.ts`, `apps/agent-host/src/session/tangent-adoption.ts`).
  This plan must decide whether lightweight branches coexist with tangents or extend them
  before it can commit milestones. <!-- D-003 -->

## 1. Objective

Close the one real capability gap the audit found (everything else Trevor already ships
equal-or-better): a **lightweight, in-thread message branch** with instant prev/next
navigation (audit C3), and an explicit **regenerate-last-turn** action (audit C6). Trevor
today only has heavy durable **tangent** forks - great for deliberate exploration, but
there is no quick "try another phrasing and flip between the variants" and no explicit
regenerate. The shape is undecided. <!-- D-001 -->

## 2. Seed items (58.6 audit, deferred)

- **C3** - in-thread branch array with a BranchPicker (`< 2/3 >` prev/next) over same-parent
  alternatives; assistant-ui `docs/guides/branching`. Trevor has no in-message variation nav.
- **C6** - an explicit regenerate-last-assistant-turn action (ActionBar Reload). Trevor has
  turn replay/supersede primitives but no user-facing regenerate.

## 3. The design question (to flesh out - NOT committed milestones)

The central undecided call, from contrarian prompts #11/#12:

- **Branches vs tangents.** assistant-ui branches are same-parent alternatives with instant
  prev/next nav; Trevor tangents are durable session-level forks with fold-back - a
  different UX job. Decide: offer BOTH (quick branch for re-phrasings, tangent for deliberate
  exploration), or extend tangents with a lightweight in-place mode. Avoid two overlapping
  fork models that confuse users.
- **Regenerate mapping.** Does regenerate-last-turn map onto Trevor's existing turn
  replay/supersede path, or a fresh run? Does each regenerate create a branch (so you can
  flip between the old and new answer), tying C6 back into C3?
- **Persistence.** How does an in-thread branch project into Trevor's durable event log
  without becoming a full tangent session?

## 4. Non-Goals

- No implementation until the branches-vs-tangents question is decided.
- No removal or reduction of the existing tangent capability.

## 5. Decisions

Canonical decisions are in `plan.db`.

- D-001: light stub; decide section 3 before committing milestones.
- D-002: fresh integer 64; product/UX feature seeded by audit C3/C6.
- D-003: coexistence with tangents is the gating open question.
