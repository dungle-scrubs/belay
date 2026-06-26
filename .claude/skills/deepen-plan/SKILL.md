---
name: deepen-plan
as_slash_command: true
argument-hint: [times]
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
description: "Run the deepen audit X passes over the ENTIRE codebase (X = argument, default 1) and fold the findings into the `deepen` plan via the planner skill. If the deepen plan doesn't exist, create it from the candidates; if it does, identify only NEW deepening opportunities not already in the plan (dedup against existing entries) and add them. Audit + plan-build only - it surfaces and records shallow-module candidates, it does NOT implement them. A higher-order wrapper around ~/.agents/skills/deepen + ~/.agents/skills/planner. Triggers: deepen X times, build the deepen plan, add deepening opportunities, sweep for shallow modules, run deepen repeatedly, /deepen-plan."
---

# Deepen Plan

## Purpose

Run the `deepen` audit (find shallow modules / leaky abstractions / pass-through wrappers across
existing code) `TIMES` passes over the WHOLE repository, and accumulate the findings into the `deepen`
plan through the `planner` skill - creating the plan on the first run and only ADDING newly-found
opportunities (not already recorded) on later runs. The loop builds a comprehensive, deduped backlog
of deepening candidates; it does not redesign or implement any of them.

This is audit + plan-build. `deepen` surfaces candidates, `planner` records them; acting on a candidate
is a separate, later step (the user picks one and runs `planner` to redesign it).

## Variables

- `TIMES: $ARGUMENTS` - how many deepen→record passes to run. Default `1` when the argument is empty or
  not a positive integer.
- `PLAN` - the `deepen` plan (planner's plan-db, conventionally `.plans/deepen/`). Its existing entries
  are the dedup source.

## Workflow

```
PARSE TIMES from $ARGUMENTS (a positive integer); default to 1 if empty/invalid.
CHECK whether the `deepen` plan already exists (e.g. `.plans/deepen/`).

FOR pass = 1 .. TIMES:
  1. Announce "deepen pass <pass>/<TIMES>".

  2. Invoke the `deepen` skill at WHOLE-REPOSITORY scope (the argument is a count, not a scope - always
     audit the entire codebase). It returns a ranked list of shallow-module candidates, each with its
     symptom, evidence, and a proposed deeper boundary.

  3. Read the current `deepen` plan to know what is ALREADY captured (by the module/boundary each
     candidate targets + its symptom). Treat those as off-limits for re-adding.

  4. DEDUP: keep only the candidates that are genuinely NEW - not already a milestone/candidate in the
     plan, and not a duplicate of one already added earlier in this same loop.

  5. Record via the `planner` skill:
       IF the `deepen` plan does NOT exist:
         Invoke `planner` to CREATE the `deepen` plan, seeded with this pass's candidates as ranked
         milestones (one candidate = one milestone, in deepen's own ranked order).
       ELSE:
         Invoke `planner` (iterate mode) to ADD the new, deduped candidates to the existing `deepen`
         plan, preserving its structure and ranking convention.

  6. IF this pass added NOTHING new (every candidate was already in the plan):
       STOP early - the codebase audit has converged; more passes would just re-find recorded items.
       Note convergence at pass <pass> of <TIMES>.

After the loop, summarize: passes run (and whether it converged early), how many NEW candidates were
added across all passes, and the plan's total candidate count.
```

## Instructions

- The argument is the iteration COUNT, never a scope - every pass audits the entire codebase. (To
  deepen one area instead, the bare `deepen` skill takes a scope.)
- IMPORTANT: never add a candidate that is already in the plan. Dedup every pass against the existing
  plan AND against what earlier passes in this loop already added; the whole point of multiple passes
  is to surface what previous passes MISSED, not to re-list what they found.
- IMPORTANT: this skill plans, it does not implement. Do not redesign or edit any candidate's code -
  `deepen` audits, `planner` records, and acting on a candidate is a separate later step.
- Stop early once a pass adds nothing new; `TIMES` is an upper bound on thoroughness, not a quota.
- Let the wrapped skills own their work: `deepen` owns the audit + ranking, `planner` owns the plan-db
  structure and the create-vs-iterate decision. This skill only sequences them and dedups between them.
