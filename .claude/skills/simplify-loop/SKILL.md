---
name: simplify-loop
as_slash_command: true
argument-hint: [times]
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
description: "Run the simplify skill repeatedly - X passes over the changed code, fixing issues each pass - where X is the argument (default 1). Each pass re-reviews the current diff (a prior pass's fixes can surface new cleanups), and the loop stops early once a pass finds nothing left to fix. A higher-order wrapper around ~/.agents/skills/simplify. Triggers: simplify X times, run simplify repeatedly, simplify loop, keep simplifying until clean, /simplify-loop."
---

# Simplify Loop

## Purpose

Run the `simplify` skill (review *changed* code for reuse/quality/efficiency and fix what it finds)
`TIMES` passes in a row, so the changed surface is repeatedly reviewed-and-cleaned until it settles.
One pass fixes the obvious issues; a later pass catches what those fixes newly expose. This skill only
orchestrates the loop - all the actual review/fix logic lives in `~/.agents/skills/simplify`.

## Variables

- `TIMES: $ARGUMENTS` - how many `simplify` passes to run. Default `1` when the argument is empty or
  not a positive integer.

## Workflow

```
PARSE TIMES from $ARGUMENTS (a positive integer); default to 1 if empty/invalid.

FOR pass = 1 .. TIMES:
  1. Announce "simplify pass <pass>/<TIMES>".
  2. Invoke the `simplify` skill (it reviews the current git diff / recently-changed files via its
     three review agents, then fixes the issues it confirms).
  3. Record what that pass changed (files touched, fixes applied) and whether it found anything.
  4. IF the pass found and fixed NOTHING (a clean pass):
       STOP the loop early - further identical passes would be wasted work. Note that it converged
       at pass <pass> of <TIMES>.
     ELSE:
       Continue to the next pass; the next pass reviews the now-updated diff.

After the loop, summarize: passes run (and whether it stopped early on a clean pass), and the net set
of fixes across all passes.
```

## Instructions

- This is a thin loop. Do NOT re-implement simplify's review here - invoke the `simplify` skill each
  pass and let it own the diff selection, the parallel review agents, and the fixes.
- Each pass operates on the CURRENT changed code, which includes the previous pass's fixes - that
  evolving diff is the point of looping.
- IMPORTANT: stop early on the first clean pass. `TIMES` is an upper bound, not a quota; running more
  passes once nothing is left to fix adds churn, not value.
- Keep each pass's verification (lint/tests, as simplify does) intact; never mark the loop done while a
  pass left failing checks.
