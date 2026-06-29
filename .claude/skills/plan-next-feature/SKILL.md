---
name: plan-next-feature
as_slash_command: true
argument-hint: [topic]
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
description: "Decide what the next Trevor V2 feature should look like BEFORE writing it into a plan. Pick the topic from the argument (e.g. git), or else propose the next open item with the user from the existing numbered plans. Gather and present three comparisons - how V1 (~/dev/trevor) does it, what V2 (this project) already does, and what the existing numbered plans under /Users/kevin/dev/trevorV2/.plans say - then decide collaboratively with the user. Only AFTER the design is fully agreed: run the planner skill's plan-db workflow to create or extend a numbered plan under .plans/<NN>-<name>/ with RED/GREEN/REFACTOR milestones, record the plan in AGENTS.md, and commit plan docs to the main branch only. Triggers: plan the next feature, decide the next feature, what should we build next for Trevor V2, spec a feature, discuss a topic for the plan, next open item, /plan-next-feature."
---

# Plan the Next Trevor V2 Feature

## When to Use This Skill

Use when deciding what a Trevor V2 feature should look like before it goes into a plan -
"let's plan git", "what should we build next", "decide the next open item", "spec <topic>",
or an explicit `/plan-next-feature <topic>`. This is a DECISION workflow: it gathers evidence,
drives a joint decision, and only then writes the plan. It does not implement code.

## Variables

- `TOPIC: $ARGUMENTS` - the feature topic to decide (e.g. `git`). Optional; when empty, the skill
  proposes the next topic with the user (Phase 1).

## Paths

- **V1** (prior art): `~/dev/trevor` - the previous Trevor. How does it do this today?
- **V2** (this project): `/Users/kevin/dev/trevorV2` - what does it already do?
- **Plans**: `/Users/kevin/dev/trevorV2/.plans/` - **numbered plan directories** `<NN>-<name>/`, each a
  self-contained plan-db (`implementation.md`, `progress-report.md`, `plan.db`, `artifacts/`). There is
  **no single umbrella plan**: the former `.plans/trevor-v2` is retired. Cross-cutting domain
  vocabulary lives in `/Users/kevin/dev/trevorV2/CONTEXT.md`; the plan policy/index lives in
  `/Users/kevin/dev/trevorV2/AGENTS.md`.
- **Planner skill**: `~/.agents/skills/planner` - the lifecycle, decision ledger, RED/GREEN/REFACTOR
  milestone shape, progress accounting, directory/numbering rules, and convergence rules this skill
  must reuse.

## Plan placement and git policy

- **Plan documents live on `main` only.** Creating a new numbered plan, or editing an existing one, is
  committed to the **`main` branch** - never authored on or committed to a feature branch. A plan's
  *implementation* happens later on its own `feat/<NN>-<name>` branch; the plan **documents**
  themselves stay on `main` as the shared backlog. (See `AGENTS.md` "Git".)
- **Keep `AGENTS.md` in sync.** Whenever you add a new plan or materially change an existing one,
  update `AGENTS.md` so it still reflects what plans exist and the canonical-plan policy. Record new
  shared domain terms in `CONTEXT.md`.
- **Numbering** (planner directory rules): a new plan gets the next free `<NN>` in **dependency order**
  - a hard dependency gets a lower number than the plan that needs it; use a decimal insertion like
  `09.5-<name>` only to slot between already-numbered plans, never renumber existing ones.

## Planner Integration

This skill exists because Trevor feature discussions need the V1/V2/existing-plans comparison before a
plan is written. It does not replace `planner`. It is a front-end decision workflow that must hand the
recording and progress-report synchronization back to the planner system.

Before any Phase 4 plan write, load the planner references:

1. `~/.agents/skills/planner/SKILL.md`
2. `~/.agents/skills/planner/_shared/cli-reference.md`
3. `~/.agents/skills/planner/_shared/invariants.md`
4. `~/.agents/skills/planner/_shared/create-mode.md` (for a new plan) or `_shared/iterate-mode.md` (to extend one)
5. `~/.agents/skills/planner/_shared/implementation-template.md`

Run all `plan-db` commands from `/Users/kevin/dev/trevorV2` with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts <command>
```

Use the **target plan name** (the `<NN>-<name>` you are creating or iterating) for `--plan`, e.g.:

```bash
plan-db status --plan "<NN>-<name>"
plan-db query-decisions --plan "<NN>-<name>"
```

If the markdown plan contains decision markers that are not represented in `plan.db`, or `plan-db` state
contradicts the markdown, stop and report the sync issue instead of minting conflicting D-ids or silently
writing around the ledger.

## Workflow

### Phase 1 - Pick the topic

```
IF TOPIC is non-empty:
  THE TOPIC = TOPIC (e.g. "git").
ELSE:
  Survey the existing numbered plans under .plans/ (their stages via `plan-db list-plans`) and the
  AGENTS.md plan policy, plus the obvious V1/V2 gaps, and PROPOSE the next topic to the user. There is
  no single roadmap file to read from - confirm the topic with the user before continuing.
```

State the chosen topic in one sentence before continuing.

### Phase 2 - Gather the three comparisons (do NOT decide yet)

Investigate the topic in each source and report findings side by side. Read the actual code/plans;
do not assume from names.

1. **V1 - what `~/dev/trevor` already does.** Find and summarize how V1 implements (or doesn't) this
   topic: the surface, the model, the rough mechanism. This is prior art to learn from, not a target
   to copy.
2. **V2 - what this project already does.** Search `/Users/kevin/dev/trevorV2` for anything related:
   existing tools, host paths, protocol events, web UI, partial support. What exists vs. what's
   missing.
3. **Plans - what the existing numbered plans say.** What the relevant numbered plans under `.plans/`
   (and `CONTEXT.md` vocabulary) already record about this topic - decisions, constraints, sequencing,
   hard dependencies - if anything. Note any plan this work depends on or overlaps with.

Present these as a compact comparison (V1 / V2 / plans), then surface the open design questions and
the trade-offs between them. **Stop and discuss - do not write any files yet.**

### Phase 3 - Decide collaboratively (HARD GATE)

Converge with the user on what the feature should look like: surface, mechanism, scope/cut, where it
lives in V2's architecture, its hard dependencies on other plans, and how it numbers/sequences against
the rest.

> IMPORTANT: Do NOT create or edit any plan files until the design is FULLY agreed with the user.
> "Fully decided" means the user has confirmed the shape - not your own conclusion. Recommend a default
> and say why, but the decision is joint. If anything is still open, keep discussing; do not write
> ahead of the decision.

### Phase 4 - Record through planner (only after full agreement)

1. **Load the planner references and plan-db state** listed in Planner Integration. Decide whether this
   is a **new** numbered plan (planner create mode) or an **edit** to an existing plan (iterate mode).
2. **Pick the target plan.** For new work, choose the next `<NN>-<name>` per dependency-order numbering
   and `plan-db init --name "<NN>-<name>"`. For changes, use the existing plan name.
3. **Record decisions in `plan.db` first** when new decisions are needed. Use `plan-db record-decision`
   with `--decided-by human` for user-confirmed choices. Do not edit SQLite directly.
4. **Write/extend `implementation.md`** to capture the decided design - `## 0. Hard Dependencies`,
   Architecture, Phases, Non-Goals - matching the format and voice of the existing numbered plans. Use
   the `<!-- D-### -->` decision-id convention. Record new shared domain terms in `CONTEXT.md`.
5. **Decompose into `progress-report.md` with planner task shape**: ranked milestones (M1, M2, ...).
   Each implementation milestone must use RED/GREEN/REFACTOR checklist items, following the planner
   implementation template:

   ```markdown
   - [ ] RED: Add failing test or characterization for ...
   - [ ] GREEN: Implement the minimum behavior for ...
   - [ ] RED: Add failing test for the next edge case ...
   - [ ] GREEN: Implement the next behavior ...
   - [ ] REFACTOR: Consolidate boundaries, naming, fixtures, or docs ...
   ```

   Storybook-first UI milestones may start with a RED item for the story/fixture expectation, then GREEN
   production wiring, then RED/GREEN behavioral tests. Verification gates remain useful, but they do not
   replace RED/GREEN/REFACTOR milestone tasks.
6. **Update progress accounting**: current focus, summary counts, deferred/superseded buckets, and any moved
   completed detail must satisfy the planner invariants.
7. **Update `AGENTS.md`.** Record the new plan (or the plan change) in `AGENTS.md` so it stays the index
   of what plans exist and the canonical-plan policy. If the plan set or a permanent decision changed,
   adjust the relevant `AGENTS.md` section.
8. **Run planner checks before replying** (use the target plan name):

   ```bash
   plan-db check-progress --plan "<NN>-<name>"
   plan-db check-convergence --plan "<NN>-<name>" --streak 3
   ```

   If either check fails, report the update as non-converged and summarize the remaining issue. Do not present
   it as complete.
9. **Commit policy - `main` only.** Leave the changes uncommitted for the user to review unless they ask
   you to commit. When they do: plan documents are committed to the **`main` branch ONLY**. Switch to
   `main`, stage **only** the plan docs (`.plans/<NN>-<name>/`), `AGENTS.md`, and `CONTEXT.md` - never
   feature-branch source code - then commit. Never author or commit plan docs on a feature branch.
10. Report what changed (files + new decisions + new Phase/milestones + AGENTS.md/CONTEXT.md updates +
    check results).

## Instructions

- This skill DECIDES and PLANS; it does not implement. Stop at the plan write.
- Always read the real V1/V2 code before claiming what either does - prior art and current state are
  evidence, not guesses.
- The decision gate is the point of the skill: the value is deciding the right shape together before
  it becomes plan debt. Never front-run the user's decision by writing the plan early.
- The planner owns lifecycle integrity. Do not bypass `plan-db`, `check-progress`, or convergence checks when
  writing plan or progress-report files.
- **Plan docs go on `main` only**, and **`AGENTS.md` must reflect new or changed plans.** Keeping the
  plan index and policy in `AGENTS.md` accurate is part of recording a plan, not an afterthought.
- RED/GREEN/REFACTOR milestone tasks are mandatory for new progress-report implementation work. A generic
  product checklist is drift unless each behavior is tied to test-first RED items, matching GREEN
  implementation items, and REFACTOR cleanup.
- Keep the comparison honest about gaps (what V2 lacks, what V1 got wrong) rather than just listing
  features.
