---
name: plan-next-feature
as_slash_command: true
argument-hint: [topic]
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
description: "Decide what the next Trevor V2 feature should look like BEFORE writing it into the canonical plan. Pick the topic from the argument (e.g. git), or else the next open item in /Users/kevin/dev/trevorV2/.plans/trevor-v2 not yet decomposed into progress-report.md. Gather and present three comparisons - how V1 (~/dev/trevor) does it, what V2 (this project) already does, and what the current .plans/trevor-v2 says - then decide collaboratively with the user. Only AFTER the design is fully agreed: run the planner skill's plan-db workflow, update .plans/trevor-v2, and add RED/GREEN/REFACTOR milestones to .plans/trevor-v2/progress-report.md. Triggers: plan the next feature, decide the next feature, what should we build next for Trevor V2, spec a feature, discuss a topic for the plan, next open item, /plan-next-feature."
---

# Plan the Next Trevor V2 Feature

## When to Use This Skill

Use when deciding what a Trevor V2 feature should look like before it goes into the plan -
"let's plan git", "what should we build next", "decide the next open item", "spec <topic>",
or an explicit `/plan-next-feature <topic>`. This is a DECISION workflow: it gathers evidence,
drives a joint decision, and only then writes the plan. It does not implement code.

## Variables

- `TOPIC: $ARGUMENTS` - the feature topic to decide (e.g. `git`). Optional; when empty, the skill
  picks the next open item itself (Phase 1).

## Paths

- **V1** (prior art): `~/dev/trevor` - the previous Trevor. How does it do this today?
- **V2** (this project): `/Users/kevin/dev/trevorV2` - what does it already do?
- **Plan**: `/Users/kevin/dev/trevorV2/.plans/trevor-v2/` - `implementation.md`,
  `progress-report.md`, `progress-report-done.md`, `plan.db`, and any living RFC/spike docs that
  `plan-db status --plan trevor-v2` reports.
- **Planner skill**: `~/.agents/skills/planner` - the lifecycle, decision ledger, RED/GREEN/REFACTOR
  milestone shape, progress accounting, and convergence rules this skill must reuse.

## Planner Integration

This skill exists because Trevor feature discussions need the V1/V2/plan comparison before the canonical plan
is updated. It does not replace `planner`. It is a front-end decision workflow that must hand the recording
and progress-report synchronization back to the planner system.

Before any Phase 4 plan update, load the planner references:

1. `~/.agents/skills/planner/SKILL.md`
2. `~/.agents/skills/planner/_shared/cli-reference.md`
3. `~/.agents/skills/planner/_shared/invariants.md`
4. `~/.agents/skills/planner/_shared/iterate-mode.md`
5. `~/.agents/skills/planner/_shared/implementation-template.md`

Run all `plan-db` commands from `/Users/kevin/dev/trevorV2` with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts <command>
```

At minimum, Phase 4 must run:

```bash
plan-db status --plan "trevor-v2"
plan-db query-decisions --plan "trevor-v2"
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
  Read .plans/trevor-v2 (the roadmap / section 6 sequenced items in implementation.md and any living
  plan docs reported by plan-db) and progress-report.md. THE TOPIC = the next open/sequenced item that is NOT yet decomposed into
  progress-report.md (no Phase + milestones for it there). State which item you picked and why.
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
3. **Plan - what `.plans/trevor-v2` currently says.** What the rfc/implementation/roadmap already
   record about this topic (decisions, constraints, sequencing), if anything.

Present these as a compact comparison (V1 / V2 / plan), then surface the open design questions and
the trade-offs between them. **Stop and discuss - do not write any files yet.**

### Phase 3 - Decide collaboratively (HARD GATE)

Converge with the user on what the feature should look like: surface, mechanism, scope/cut, where it
lives in V2's architecture, and how it sequences against the rest of the plan.

> IMPORTANT: Do NOT touch `.plans/trevor-v2` or `progress-report.md` until the design is FULLY agreed
> with the user. "Fully decided" means the user has confirmed the shape - not your own conclusion.
> Recommend a default and say why, but the decision is joint. If anything is still open, keep
> discussing; do not write ahead of the decision.

### Phase 4 - Record through planner (only after full agreement)

1. **Load the planner references and plan-db state** listed in Planner Integration. Treat this as planner
   iterate mode over the existing `trevor-v2` plan, not as a standalone hand edit.
2. **Record decisions in `plan.db` first** when new decisions are needed. Use `plan-db record-decision`
   with `--decided-by human` for user-confirmed choices. Do not edit SQLite directly.
3. **Update `.plans/trevor-v2`** to capture the decided design: extend `implementation.md` and any other
   living plan documents reported by `plan-db status`. Match the existing voice, preserve the single
   canonical-plan rule, and use the `<!-- D-### -->` decision-id convention from the ledger.
4. **Decompose it into `progress-report.md` with planner task shape**: add a new section or extend the right
   section with ranked milestones (M1, M2, ...). Each implementation milestone must use RED/GREEN/REFACTOR
   checklist items, following the planner implementation template:

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
5. **Update progress accounting**: current focus, summary counts, deferred/superseded buckets, and any moved
   completed detail must satisfy the planner invariants.
6. **Run planner checks before replying**:

   ```bash
   plan-db check-progress --plan "trevor-v2"
   plan-db check-convergence --plan "trevor-v2" --streak 3
   ```

   If either check fails, report the update as non-converged and summarize the remaining issue. Do not present
   it as complete.
7. Report what changed (files + new decisions + new Phase/milestones + check results), and leave it
   uncommitted for the user to review unless they ask you to commit.

## Instructions

- This skill DECIDES and PLANS; it does not implement. Stop at the plan update.
- Always read the real V1/V2 code before claiming what either does - prior art and current state are
  evidence, not guesses.
- The decision gate is the point of the skill: the value is deciding the right shape together before
  it becomes plan debt. Never front-run the user's decision by writing the plan early.
- The planner owns lifecycle integrity. Do not bypass `plan-db`, `check-progress`, or convergence checks when
  writing plan or progress-report files.
- RED/GREEN/REFACTOR milestone tasks are mandatory for new progress-report implementation work. A generic
  product checklist is drift unless each behavior is tied to test-first RED items, matching GREEN
  implementation items, and REFACTOR cleanup.
- Keep the comparison honest about gaps (what V2 lacks, what V1 got wrong) rather than just listing
  features.
- First canonical run: `git` - Trevor V2's git functionality (a section 6 roadmap item not yet decomposed).
