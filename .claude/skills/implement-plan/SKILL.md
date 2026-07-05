---
name: implement-plan
as_slash_command: true
argument-hint: "[<NN-name>... | next | all]"
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Skill, Task
description: "Use when the owner asks to implement, build, finish, run, or do one or more existing numbered Trevor plans under `.plans/`, or to work the backlog - the execution counterpart to authoring a plan (plan-next-feature), so prefer this when the plan already exists and the ask is to build it. Triggers: implement the plan, implement plans, do these plans, do plans NN-MM, build the plan, run the plan, finish the plan, implement-plan, work the backlog."
---

# Implement Trevor Plan(s)

End-to-end execution of numbered plans: worktree -> implement -> full test (incl. e2e) -> simplify ->
delete plan dir -> ff-merge to `main` -> prune. This is the IMPLEMENT counterpart to
`plan-next-feature` (which only authors plans). It does not design or re-scope a plan; it builds
what the plan already specifies.

## When to use

The owner asks to implement, build, finish, or "do" one or more existing plans under `.plans/`.
Forms of the request map to the `TARGET` variable below. Invoking this skill is itself the owner's
in-the-moment authorization to **commit, ff-merge into `main`, and prune locally** for the targeted
plans (the operations `AGENTS.md` otherwise gates). It is **not** authorization to `git push`, delete
a remote branch, or change repository visibility - those remain separately gated (see Guardrails).

## Variables

- `TARGET: $ARGUMENTS` - which plans to implement. Accepts:
  - one or more explicit plan ids: `03-nested-command-menu 04-archive-browser-and-delete` (or bare
    numbers `03 04`);
  - `next` - the lowest-numbered real plan that is not yet implemented and whose hard dependencies
    are all complete;
  - `all` - every real plan, run serially in dependency order;
  - empty - survey the backlog and confirm the batch with the owner before starting.

## Paths

- **Repo root (primary worktree, on `main`)**: `/Users/kevin/dev/trevor`
- **Plans**: `/Users/kevin/dev/trevor/.plans/<NN[.n]>-<name>/` - each a self-contained plan-db
  (`implementation.md`, `progress-report.md`, `plan.db`, `artifacts/`). A directory with **no
  `plan.db`** is a stub - skip it and report.
- **Per-plan worktree**: `/Users/kevin/dev/.trevor-wt/<NN[.n]>-<name>` (matches the existing
  convention, e.g. `/Users/kevin/dev/.trevor-wt/01-managed-worktree-hardening`).
- **Per-plan branch**: `feat/<NN[.n]>-<name>`.
- **Planner**: `~/.agents/skills/planner` - the implementation lifecycle this skill drives. Invoke its
  CLI as:
  ```bash
  mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts <command>
  ```
  `plan-db` resolves `.plans/` from the current directory, so run **write** commands with cwd set to
  the plan's worktree.

## Planner integration (load before implementing)

Before driving milestones, load the planner references so milestone execution matches the planner's
contract:

1. `~/.agents/skills/planner/SKILL.md`
2. `~/.agents/skills/planner/_shared/implement-mode.md`
3. `~/.agents/skills/planner/_shared/cli-reference.md`
4. `~/.agents/skills/planner/_shared/invariants.md`
5. `~/.agents/skills/planner/_shared/implementation-template.md`

The planner owns lifecycle integrity. Do not bypass `plan-db`, `check-progress`, or
`check-convergence`. Use the plan's `<NN[.n]>-<name>` for `--plan`.

## Standards

Each plan's code must meet the repo bar in `AGENTS.md` and the per-directory `AGENTS.md` files, plus
the relevant language/toolchain standards skills (`typescript-standards`, `react-standards`,
`css-standards`, `typescript-toolchain-standards`, `db-standards`, ...). Honor `CLAUDE.md`: plain `-`
never `—`, no `Co-Authored-By` trailer on commits, quality over development cost. Storage placement
follows the root taxonomy in `AGENTS.md` (`@trevor/session/node-paths`).

## Build the run order (dependency-aware, serial)

> The backlog under `.plans/` is **numbered in execution order**: `01` is the highest-priority /
> fewest-blockers plan and the last number is the most-blocked. The numbering already respects every
> hard dependency, so **ascending numeric order is the intended sequence** and the dependency check
> below is the safety net (it stays correct even if a future plan is inserted as a decimal).
>
> **Resuming is automatic.** A completed plan has had its `.plans/<NN-name>/` dir deleted on `main`,
> so `next`/`all` always pick up at the first unfinished, dependency-eligible plan, and any in-flight
> worktree/branch for a plan is reused (step 2). The owner can stop and re-run this skill at any time
> without losing place.

1. **Expand `TARGET`** into a concrete plan set. For `all`, take every plan dir that has a `plan.db`.
   For `next`, compute the eligible set then take the first. Read the plan set from **`main`**
   (`git -C /Users/kevin/dev/trevor ls-tree --name-only main .plans/`), which is the source of
   truth for what's still open - a deleted plan dir means that plan is already done.
2. **Order topologically.** For each plan read `## 0. Hard Dependencies` in its `implementation.md`.
   A plan is eligible only when **every** hard-dependency plan is complete (its `.plans/<dep>/`
   directory no longer exists on `main`, i.e. it was deleted on completion, or the dep is itself
   queued earlier in this run and passes its gate first). Within the eligible set, order by plan
   number; a decimal sub-plan (`03.1`) sorts immediately after its base (`03`). If a target's
   dependency is an un-implemented plan **not** in the batch, either pull that dependency in ahead of
   it (preferred) or defer the target and report the gap - never implement a plan with unmet hard
   deps.
3. **Run serially**, one plan at a time. Serial is deliberate (cf. plan `02-serial-worktree-implement`):
   it keeps a clean ff-merge chain and avoids parallel worktrees colliding on shared files.

## Per-plan lifecycle

Run these steps for each plan `P = <NN[.n]>-<name>` in order. `REPO=/Users/kevin/dev/trevor`,
`WT=/Users/kevin/dev/.trevor-wt/P`.

### 1. Gate on dependencies and freshness

- Confirm `P` has a `plan.db` (else skip as a stub and report).
- Confirm every hard dependency is complete (per ordering rule). If not, do not start `P`.
- Read `progress-report.md` and `plan-db status --plan P` to load remaining milestones. If the plan
  is already fully implemented but its dir still exists, jump to step 5 (complete + merge).

### 2. Create the worktree off the latest main

```bash
git -C "$REPO" worktree add "$WT" -b "feat/P" main
```

- If a worktree or branch for `P` already exists (e.g. an in-flight `01-managed-worktree-hardening`), **reuse it**
  instead of erroring: confirm via `git -C "$REPO" worktree list` and `git -C "$REPO" branch --list "feat/P"`,
  and `cd "$WT"`. Rebase onto the latest `main` only if `main` has advanced and the rebase is clean.

### 3. Implement inside the worktree

With cwd = `$WT`, drive the plan's milestones in planner implement mode:

- Work milestone by milestone: **RED** (add the failing test/characterization first), **GREEN**
  (minimum code to pass), **REFACTOR** (consolidate). Keep `plan-db` progress current
  (`add-pass`, `check-progress`).
- Install new deps with `pnpm install` from `$WT` when a milestone adds them.
- Commit incrementally on `feat/P` with conventional-commit messages, **no `Co-Authored-By` trailer**.
  Stage only files belonging to this plan.
- For a large or multi-subsystem milestone, an `Explore`/`general-purpose` subagent may gather context,
  but the implementing edits and the gate stay in this lifecycle.

### 4. Full verification gate (must be fully green before any merge)

From `$WT`, run the complete bar - this is the hard gate `AGENTS.md` defines (unit + integration +
web green **plus** the hermetic e2e lane), extended with lint, typecheck, and planner convergence:

```bash
pnpm lint           # biome check .
pnpm typecheck      # pnpm -r typecheck
pnpm test           # vitest run -> unit + integration + web + hermetic e2e
```

Then the planner checks:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress    --plan "P"
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-convergence --plan "P" --streak 3
```

- The hermetic e2e lane (`pnpm test:e2e`) is **required**. The live-model e2e lane is gated: when a
  prerequisite (LM Studio, `~/.pi/auth.json`) is absent it must **skip with a stated reason**, never
  fail the run - record which lanes ran vs. skipped.
- **Real-browser e2e** (driving the actual web app in a browser, not the hermetic vitest lane) goes
  through the **tool-proxy `browser-tools`** MCP integration, run **headless** - never direct
  browser-control CLIs or ad hoc automation scripts (per global `CLAUDE.md`). If tool-proxy is **not
  available** and the current plan needs to be tested in a browser, **stop and tell the owner** rather
  than substituting another driver or silently skipping the browser verification.
- If the plan ends with a **Manual EZE** step, attempt it. If it genuinely needs interactive or live
  resources that aren't available headlessly, record it as a **deferred manual EZE** in the report
  rather than silently dropping it - and surface it to the owner.
- **If anything fails and cannot be fixed:** stop this plan. Leave `$WT` + `feat/P` intact, do **not**
  delete the plan dir, do **not** merge. Report the failure with output. Continue to the next plan
  only if it does not depend on the failed one; otherwise stop the run.

### 4b. Simplify pass before merge (one pass, fix everything)

After the step-4 gate is green and **before any merge**, run exactly **one pass** of the `simplify`
skill (`~/.agents/skills/simplify`) over this plan's changes, with cwd = `$WT` (review surface =
`feat/P`'s diff vs `main`). Invoke it via the `Skill` tool (`simplify`). **Fix everything it finds**
in that pass - reuse, duplication, dead code, quality, and efficiency issues - and commit the
cleanups on `feat/P`. This is a single pass, **not** `simplify-loop`.

Because the cleanups change code, **re-run the full step-4 gate** afterward (lint + typecheck + test
+ planner `check-progress` / `check-convergence`). Proceed to completion only once the gate is green
again. If simplify's fixes can't be made green, stop the plan and leave it un-merged (per
Guardrails) - never merge a half-applied cleanup.

### 5. Complete the plan (only on a fully green gate)

In `$WT`:

```bash
git rm -r .plans/P/
# `git rm` only removes TRACKED files. A plan dir also carries an untracked, never-committed
# `artifacts/` subdir (git does not track empty dirs), which survives `git rm -r` and keeps an
# empty `.plans/P/` folder on disk. Remove the whole directory outright so the plan folder is
# fully gone from the working tree, not just emptied of its tracked files.
rm -rf .plans/P/
git commit -m "chore(plans): remove completed P plan"
```

(Per the plan git workflow this is typically a separate commit after the feature commits.)

### 6. Fast-forward-merge into main

Merge happens in the **primary worktree**, which is already on `main` - never `git checkout main` in a
shared checkout (it would switch another session's branch out from under it).

- Verify the primary tree is on `main` and clean:
  `git -C "$REPO" symbolic-ref --short HEAD` == `main` and `git -C "$REPO" status --porcelain` empty.
  If it is **not** on `main` or not clean, hold the merge, keep `$WT`/`feat/P`, and report - do not
  force it.
- Merge linearly:
  ```bash
  git -C "$REPO" merge --ff-only "feat/P"
  ```
- If `--ff-only` is rejected because `main` advanced, rebase `feat/P` onto `main` inside `$WT`,
  **re-run the full step-4 gate**, then merge. Never create a merge commit; history stays linear.
- **After the merge, scrub the plan dir from the primary tree.** The merge removes the *tracked*
  plan files from `main`'s working tree, but any **untracked** leftover inside `$REPO/.plans/P/` (a
  Finder `.DS_Store` from browsing the folder, a SQLite `plan.db-wal`/`plan.db-shm` sidecar) keeps the
  now-empty directory alive on disk - the empty folder the owner sees on `main`. Remove it outright so
  the plan folder is fully gone, then confirm:
  ```bash
  rm -rf "$REPO/.plans/P"
  test -d "$REPO/.plans/P" && echo "STILL PRESENT - investigate" || echo "plan dir gone"
  ```
  This deletes only untracked cruft (the tracked files are already removed by the merge), so it never
  touches committed history. Do the same in `$WT` before pruning if you ever inspect it post-merge.

### 7. Prune locally

```bash
git -C "$REPO" worktree remove "$WT"
git -C "$REPO" branch -d "feat/P"        # -d is safe: branch is merged
git -C "$REPO" remote prune origin       # drop stale tracking refs
```

`feat/P` was never pushed, so there is no remote branch to delete. If a branch ever *was* pushed,
deleting it on origin (`git push origin --delete feat/P`) is a remote op and needs the owner's
in-the-moment go-ahead (see Guardrails) - do not assume it.

### 8. Report and advance

Summarize for `P`: milestones completed, test result counts per lane, e2e lanes run vs. skipped (with
reason), any deferred manual EZE, and the merge SHA on `main`. Then proceed to the next plan. Maintain
a running task list (`TaskCreate`/`TaskUpdate`) across the batch so progress is visible.

## Guardrails

- **Never merge red, never merge un-simplified.** The full step-4 gate (lint + typecheck + unit +
  integration + web + hermetic e2e + planner convergence) must pass, **and** one `simplify` pass
  (step 4b) must have run with its findings fixed and the gate re-confirmed green, before the plan
  dir is deleted or the branch merged. A failing plan is left un-merged for the owner.
- **Never `git push`, delete a remote branch, or change repo visibility.** This repo is **private and
  must stay private**. Local commit + ff-merge + local prune are covered by running this skill;
  anything touching origin or visibility needs a separate, explicit, in-the-moment owner instruction.
- **Never switch the shared checkout's branch.** Merge into `main` in the primary worktree while it is
  already on `main`; do all implementation in per-plan worktrees.
- **One plan per branch/worktree.** Do not mix two plans on one branch.
- **Serial, dependency-ordered.** Do not implement a plan whose hard dependencies are unmet.
- **No `Co-Authored-By` trailer; plain `-` not `—`.** (global `CLAUDE.md`).
- **Don't renumber or re-scope plans.** This skill builds the plan as written; new scope is a job for
  `plan-next-feature`.

## Instructions

- This skill IMPLEMENTS; `plan-next-feature` DECIDES/PLANS. Keep the boundary.
- Read the actual plan (`implementation.md` + `progress-report.md` + `plan-db status`) before coding;
  do not infer scope from the plan name.
- Keep the planner ledger authoritative - drive milestones through `plan-db`, do not write around it.
- Report honestly: if a lane was skipped, say which and why; if a manual EZE was deferred, say so; if a
  plan failed the gate, show the output and leave it un-merged. Done means the gate passed and the
  branch is merged into `main`.
