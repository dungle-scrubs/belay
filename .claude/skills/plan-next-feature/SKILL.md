---
name: plan-next-feature
as_slash_command: true
argument-hint: [topic]
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
description: "Decide what the next Trevor V2 feature should look like BEFORE writing it into the plan. Pick the topic from the argument (e.g. git), or else the next open item in /Users/kevin/dev/trevorV2/.plans/trevor-v2 not yet decomposed into progress-report.md. Gather and present three comparisons - how V1 (~/dev/trevor) does it, what V2 (this project) already does, and what the current .plans/trevor-v2 says - then decide collaboratively with the user. Only AFTER the design is fully agreed: update .plans/trevor-v2 and add the decomposed milestone to .plans/trevor-v2/progress-report.md. Triggers: plan the next feature, decide the next feature, what should we build next for Trevor V2, spec a feature, discuss a topic for the plan, next open item, /plan-next-feature."
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

## Paths (the three sources to compare)

- **V1** (prior art): `~/dev/trevor` - the previous Trevor. How does it do this today?
- **V2** (this project): `/Users/kevin/dev/trevorV2` - what does it already do?
- **Plan**: `/Users/kevin/dev/trevorV2/.plans/trevor-v2/` - `rfc.md`, `implementation.md`,
  `progress-report.md`, `plan.db`. The current decided design + the open roadmap.

## Workflow

### Phase 1 - Pick the topic

```
IF TOPIC is non-empty:
  THE TOPIC = TOPIC (e.g. "git").
ELSE:
  Read .plans/trevor-v2 (the roadmap / §6 sequenced items in rfc.md + implementation.md) and
  progress-report.md. THE TOPIC = the next open/sequenced item that is NOT yet decomposed into
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

### Phase 4 - Record the decision (only after full agreement)

1. **Update `.plans/trevor-v2`** to capture the decided design: extend `rfc.md` / `implementation.md`
   (and the `plan.db` notes if used) in the existing voice - the design, key constraints, and where it
   sequences. Match the file's existing structure and the `<!-- D-### -->` decision-id convention.
2. **Decompose it into `progress-report.md`**: add a new Phase section (or extend the right one) with
   ranked milestones (M1, M2, …) and per-milestone checklists, mirroring how the existing phases are
   written (Source line, `- [ ]` items, a verification milestone). Update the report's summary/totals
   and the top focus note so the new feature reads as the next sequenced work.
3. Report what you changed (files + the new Phase/milestones), and leave it uncommitted for the user
   to review unless they ask you to commit.

## Instructions

- This skill DECIDES and PLANS; it does not implement. Stop at the plan update.
- Always read the real V1/V2 code before claiming what either does - prior art and current state are
  evidence, not guesses.
- The decision gate is the point of the skill: the value is deciding the right shape together before
  it becomes plan debt. Never front-run the user's decision by writing the plan early.
- Keep the comparison honest about gaps (what V2 lacks, what V1 got wrong) rather than just listing
  features.
- First canonical run: `git` - Trevor V2's git functionality (a §6 roadmap item not yet decomposed).
