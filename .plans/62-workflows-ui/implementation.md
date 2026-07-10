# Workflows UI - Implementation Plan (stub)

> **Status: intentionally minimal.** This plan parks a single deferred idea so it is
> not forgotten. Almost nothing is decided. Flesh it out - through a design pass or the
> planner interview - before committing milestones. <!-- D-001 -->

## 0. Hard Dependencies

- [ ] OPEN: relationship to `.plans/21-workflows-runtime` (the workflows engine,
  authored + hardened, not yet implemented) and `.plans/46-worktree-fleet` (a built-in
  workflow on that engine). This plan is the missing *UI/transcript surface* for
  workflow runs; whether it depends on 21 shipping, and whether it should instead be a
  decimal off 21 or 46, is undecided. Settle when fleshing out. <!-- D-002 -->

## 1. Objective

Give workflow / multi-agent runs a transcript (or support-panel) surface. Today
Trevor renders inline agent rows (`apps/web/src/transcript.ts:893`) and background
delegation blocks (`:956`), but a running *workflow* has no dedicated surface. This
plan holds that gap; the shape is undecided. <!-- D-001 -->

## 2. Seed item (58.6 audit F13, deferred)

The only content today. From the 58.6 audit row F13 (deferred, not adopt):

- A **read-only nested rendering** of a running workflow / sub-agent's activity,
  inheriting the parent's tool renderers - NOT a replacement of the existing inline
  agent rows or delegation blocks, and NOT independently interactive. <!-- D-003 -->
- There is **no concrete assistant-ui primitive to adopt** here - the assistant-ui
  `multi-agent` docs describe a pattern, not a reusable component - so any
  implementation is Trevor-owned.

## 3. Open questions (to flesh out - NOT committed milestones)

- **Placement.** Inline in the transcript, or in the support panel where running
  delegations already surface? (The report's own F13 contrarian question.)
- **Trigger.** Does this depend on the workflows runtime (`21`) actually shipping a
  workflow-run event stream to render? What events exist / would exist?
- **Numbering.** Keep `62`, or renumber as a decimal off `21` / `46` once the
  dependency is real.
- **Scope vs. existing surfaces.** How does a workflow surface relate to (and avoid
  duplicating) inline agent rows and delegation blocks?

## 4. Non-Goals

- No implementation until the seed is designed and the `21`/`46` relationship is settled.
- No replacement of the existing inline agent rows or delegation blocks.
- No adoption of an assistant-ui runtime/component for this (none fits).

## 5. Decisions

Canonical decisions are in `plan.db`.

- D-001: minimal stub; almost nothing decided; flesh out before committing milestones.
- D-002: fresh integer 62; relationship to `21`/`46` is an open question.
- D-003: seed = 58.6 audit F13 (read-only nested workflow rendering, Trevor-owned).
