---
name: plan-next-feature
as_slash_command: true
argument-hint: [topic]
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
description: "Spec a new Trevor plan when a need arises - typically a fix or follow-up discovered while another plan is being implemented - decide its shape, then record it through the planner. There is no umbrella plan to extract from; new plans are simply created as needed. Numbering default: a decimal off the plan currently being implemented (current plan 03 -> 03.1, then 03.2, ...), so the fix is queued right after the work in flight. Exception: if the new plan depends on an existing plan, slot it as a decimal off that dependency instead (depends on 40 -> 40.1). Gather and present three comparisons - how trevor legacy (~/dev/trevor_legacy) does it, what Trevor already does, and what the existing numbered plans under /Users/kevin/dev/trevor/.plans say - then decide collaboratively with the user. Only AFTER the design is agreed: run the planner plan-db workflow to create the numbered plan under .plans/<NN.n>-<name>/ with RED/GREEN/REFACTOR milestones, and commit the plan docs to the main branch through a throwaway worktree WITHOUT switching the current branch. After writing it, thread the new plan into any later plans whose assumptions it changes (forward-dependency + accommodation), skipping any plan with a live feature branch. Triggers: plan the next feature, new plan, spec a feature, decide the next feature, fix discovered during implementation, slot in a plan, discuss a topic for the plan, /plan-next-feature."
---

# Plan the Next Trevor Feature

## When to Use This Skill

Use when a new Trevor plan needs to exist - "let's plan git", "what should we build next",
"spec <topic>", or an explicit `/plan-next-feature <topic>`. The typical trigger is reactive: you
realize mid-implementation of one plan that you need a separate fix or follow-up, and you want it
queued to run soon. There is no umbrella plan to extract from - plans are simply created as the
need arises. This is a DECISION workflow: it gathers evidence, drives a joint decision, and only
then writes the plan. It does not implement code, and it never disturbs the plan/branch already in
flight (see "Plan placement, numbering, and git policy").

## Variables

- `TOPIC: $ARGUMENTS` - the feature topic to decide (e.g. `git`). Optional; when empty, the skill
  proposes the next topic with the user (Phase 1).

## Paths

- **trevor legacy** (prior art): `~/dev/trevor_legacy` - the previous Trevor. How does it do this today?
- **Trevor** (this project): `/Users/kevin/dev/trevor` - what does it already do?
- **Plans**: `/Users/kevin/dev/trevor/.plans/` - **numbered plan directories** `<NN[.n]>-<name>/`
  (integer slots like `03-...`, decimal slots like `03.1-...`), each a self-contained plan-db
  (`implementation.md`, `progress-report.md`, `plan.db`, `artifacts/`). There is **no single umbrella
  plan**: the former `.plans/trevor-v2` is retired. Cross-cutting domain vocabulary lives in
  `/Users/kevin/dev/trevor/CONTEXT.md`; the plan *policy* (not a per-plan index) lives in
  `/Users/kevin/dev/trevor/AGENTS.md`.
- **Planner skill**: `~/.agents/skills/planner` - the lifecycle, decision ledger, RED/GREEN/REFACTOR
  milestone shape, progress accounting, directory/numbering rules, and convergence rules this skill
  must reuse.

## Plan placement, numbering, and git policy

### Numbering - decimal off the current plan (default), or off a dependency (exception)

- **Default: a decimal off the plan currently being implemented.** A new plan takes the next free
  decimal suffix on the number of the plan in flight, so it runs soon after the current work. If plan
  `03` is being implemented, the new plan is `03.1`; the next one `03.2`; and so on. Plans are
  implemented in number order, and these new plans are usually fixes you want done immediately - so
  slotting them right after the current plan is what gets them prioritized.
- **Exception: a decimal off a dependency plan.** If the new plan depends on an existing plan, slot it
  as a decimal after **that dependency** instead of the current plan. If the dependency is plan `40`,
  the new plan is `40.1` (next free decimal under `40`). A hard dependency always wins over the
  "after the current plan" default.
- **Identify the base plan, then take the next free decimal.** The base is normally the in-flight plan -
  identified by the current `feat/<NN>-<name>` branch, or the `plan-db` plan at `implementing` stage; if
  it is ambiguous, confirm with the user. Read the existing plan set from **`main`** (`git ls-tree main
  .plans/`), not the current feature branch's `.plans/`, which can lag `main`. Take the lowest unused
  `<base>.<n>` (e.g. if `03.1` and `03.2` exist, the new plan is `03.3`).
- **Never renumber existing plans.** Only ever add a new decimal; integer slots and existing decimals
  stay put.

### Git - plan docs go on `main`, committed WITHOUT switching branches

- **A new plan must not touch the current plan or the current branch.** Another session may be
  mid-implementation on that branch. Switching it out from under that session - even briefly with
  `git checkout main` - changes its branch without its knowledge and can collide with its uncommitted
  work. So author and commit the plan on `main` through a **throwaway `main` worktree**, never by
  switching the shared working tree. (Phase 4 step 9 has the exact procedure.) Once the user adopts
  one-worktree-per-plan for implementation, this is the same isolation principle applied to planning.
- **Plan implementation happens later** on the plan's own `feat/<NN.n>-<name>` branch off `main`; the
  plan documents stay on `main` as the shared backlog.
- **Keep `AGENTS.md`/`CONTEXT.md` in sync only when they actually change.** `AGENTS.md` holds the plan
  *policy*, not a per-plan index (it does not enumerate plans by name), so a new plan usually needs no
  `AGENTS.md` edit. Update `AGENTS.md` only when the policy changes, and `CONTEXT.md` when the plan
  introduces shared domain vocabulary - and include those edits in the same `main` worktree commit.

### Downstream accommodation - adjust the later plans the new plan changes

- **Placement implies downstream edits.** Plans are implemented in number order, so a new plan lands
  *before* the higher-numbered plans. Any later plan whose assumptions the new plan invalidates or
  extends must be threaded with a forward dependency + accommodation, or it will be implemented against
  a stale design. This is the mirror image of the new plan's own `## 0. Hard Dependencies`.
- **Conservative and concrete.** Only adjust a later plan with a real interaction - a changed contract,
  a new task, a coexistence boundary - not one that is merely topically related. Record which plans were
  considered and skipped.
- **Never edit a plan that has a live branch/worktree.** Run `git worktree list` / `git branch` first; a
  `feat/<NN>` branch will later merge and delete `.plans/<NN>`, so a `main`-side edit to that dir becomes
  a modify/delete conflict. Surface those for the owner instead of editing them. (Phase 4 step 9 has the
  procedure.)

## Planner Integration

This skill exists because Trevor feature discussions need the trevor legacy / Trevor / existing-plans comparison before a
plan is written. It does not replace `planner`. It is a front-end decision workflow that must hand the
recording and progress-report synchronization back to the planner system.

Before any Phase 4 plan write, load the planner references:

1. `~/.agents/skills/planner/SKILL.md`
2. `~/.agents/skills/planner/_shared/cli-reference.md`
3. `~/.agents/skills/planner/_shared/invariants.md`
4. `~/.agents/skills/planner/_shared/create-mode.md` (for a new plan) or `_shared/iterate-mode.md` (to extend one)
5. `~/.agents/skills/planner/_shared/implementation-template.md`

Invoke `plan-db` with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts <command>
```

`plan-db` resolves `.plans/` from the current directory. Read-only surveys (`list-plans`, `status`)
may run from `/Users/kevin/dev/trevor`, but everything that **writes** plan state in Phase 4
(`init`, `record-decision`, `add-doc`, `add-pass`, `check-progress`, `check-convergence`) must run
with the cwd set to the throwaway **`main` worktree** from Phase 4 step 9 - so the plan is authored
on `main` and the shared checkout is never switched.

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
	  AGENTS.md plan policy, plus the obvious trevor legacy / Trevor gaps, and PROPOSE the next topic to the user. There is
  no single roadmap file to read from - confirm the topic with the user before continuing.
```

State the chosen topic in one sentence before continuing.

### Phase 2 - Gather the three comparisons (do NOT decide yet)

Investigate the topic in each source and report findings side by side. Read the actual code/plans;
do not assume from names.

1. **trevor legacy - what `~/dev/trevor_legacy` already does.** Find and summarize how trevor legacy implements (or doesn't) this
   topic: the surface, the model, the rough mechanism. This is prior art to learn from, not a target
   to copy.
2. **Trevor - what this project already does.** Search `/Users/kevin/dev/trevor` for anything related:
   existing tools, host paths, protocol events, web UI, partial support. What exists vs. what's
   missing.
3. **Plans - what the existing numbered plans say.** What the relevant numbered plans under `.plans/`
   (and `CONTEXT.md` vocabulary) already record about this topic - decisions, constraints, sequencing,
   hard dependencies - if anything. Note any plan this work depends on or overlaps with.

Present these as a compact comparison (trevor legacy / Trevor / plans), then surface the open design questions and
the trade-offs between them. **Stop and discuss - do not write any files yet.**

### Phase 3 - Decide collaboratively (HARD GATE)

Converge with the user on what the feature should look like: surface, mechanism, scope/cut, where it
	lives in Trevor's architecture, its hard dependencies on other plans, and how it numbers/sequences against
the rest. Once placement is fixed, also name the *downstream* plans the new one changes assumptions for -
the later plans that will need to accommodate it (threaded in Phase 4 step 9).

> IMPORTANT: Do NOT create or edit any plan files until the design is FULLY agreed with the user.
> "Fully decided" means the user has confirmed the shape - not your own conclusion. Recommend a default
> and say why, but the decision is joint. If anything is still open, keep discussing; do not write
> ahead of the decision.

### Phase 4 - Record through planner (only after full agreement)

1. **Load the planner references and plan-db state** listed in Planner Integration, and decide whether
   this is a **new** numbered plan (planner create mode) or an **edit** to an existing plan (iterate
   mode). Then **create the throwaway `main` worktree** that every write step below runs inside, so the
   plan is authored on `main` without switching the shared checkout:

   ```bash
   WT="$(mktemp -d)/main-wt"
   git worktree add "$WT" main
   # run every plan-db write and file edit below with the cwd set to "$WT"
   ```

   (If the shared checkout is already on `main` - no plan in flight - you may write directly and skip the
   worktree; there is no branch to switch.)
2. **Pick the target plan and number** (see "Numbering" above). For new work, pick the base plan -
   default the in-flight plan, exception a dependency plan - take the next free `<base>.<n>` decimal read
   from `main` (`git ls-tree main .plans/`), and `plan-db init --name "<NN.n>-<name>"` (run inside `$WT`).
   For changes to an existing plan, use that plan's name.
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
7. **Touch `AGENTS.md`/`CONTEXT.md` only if they actually change.** `AGENTS.md` carries the plan *policy*,
   not a per-plan index (it does not list plans by name), so a new plan usually needs no `AGENTS.md` edit -
   update it only when the policy itself changes. Record genuinely new shared domain vocabulary in
   `CONTEXT.md`. Make any such edits inside `$WT` so they ride the same `main` commit.
8. **Run planner checks before replying** (use the target plan name):

   ```bash
   plan-db check-progress --plan "<NN.n>-<name>"
   plan-db check-convergence --plan "<NN.n>-<name>" --streak 3
   ```

   If either check fails, report the update as non-converged and summarize the remaining issue. Do not present
   it as complete.
9. **Accommodate the downstream plans the new plan changes.** A new plan often invalidates or extends
   assumptions that *later* plans were written against (a turn can now span multiple models; a new event
   or transcript-row kind exists; a child/fork now inherits new state). After the new plan's number and
   placement are fixed (Phase 3), thread it into every later plan whose design it changes - the same
   forward-dependency + accommodation you would want if those plans were being authored today:
   - **Find the real set, conservatively.** Read each candidate later plan's actual `implementation.md`
     and `progress-report.md` (fan out read-only sub-agents for breadth). Adjust a plan only when there
     is a *concrete* accommodation - a changed contract, a new task, a coexistence boundary - never for a
     merely topically-related plan. State which plans you considered and skipped.
   - **SKIP any plan with a live feature branch or worktree.** Run `git worktree list` and `git branch`
     first. Editing `.plans/<NN>` on `main` while a `feat/<NN>` branch exists collides with that branch's
     eventual merge (which deletes the plan dir) - a modify/delete conflict. Leave those for the owner and
     call them out instead of editing them.
   - **For each accommodated plan, inside `$WT`:** add a `- [ ]` forward-dependency bullet under its
     `## 0. Hard Dependencies` referencing the new plan; add a brief note plus a `<!-- D-### -->` marker
     at the most relevant section; if real new behavior is implied, add matching RED/GREEN tasks to the
     right milestone in **both** `implementation.md` and `progress-report.md` and bump that progress
     report's Summary counts. Then `plan-db record-decision --decided-by human`, and run
     `plan-db check-progress` and `plan-db check-convergence --plan "<NN>-<name>" --streak 3` for that
     plan before moving on. A reference-only accommodation (no new behavior) is just the dependency bullet
     + note/marker + decision; it does not touch the progress report's task counts.
10. **Commit on `main` via the worktree, then tear it down - never switch branches.** The Phase 3 design
   agreement is the review gate, so record and commit the plan inside `$WT` (uncommitted work there is
   lost when the worktree is removed). Stage **only** the plan docs plus any `AGENTS.md`/`CONTEXT.md`
   edits you actually made - never feature-branch source - then commit (no `Co-Authored-By` trailer) and
   remove the worktree:

   ```bash
   cd "$WT"
   git add .plans/<NN.n>-<name>/        # add AGENTS.md / CONTEXT.md only if you changed them
   git commit -m "docs(plans): add plan <NN.n> <name>"
   # if step 9 accommodated downstream plans, commit those as a SEPARATE commit:
   git add .plans/<downstream-NN>/ ...   # only the later plans you actually edited
   git commit -m "docs(plans): thread <NN.n> <name> into downstream plans (...)"
   cd - >/dev/null
   git worktree remove "$WT"
   ```

   If the user wants to eyeball the files before the commit, pause after authoring and keep `$WT`. Never
   `git checkout main` in the shared working tree, and never author or commit plan docs on a feature
   branch. Afterward, confirm the shared checkout is still on its original branch and unmodified.
11. Report what changed (files + new decisions + new Phase/milestones + AGENTS.md/CONTEXT.md updates +
    the downstream plans accommodated and the ones considered-but-skipped + check results).

## Instructions

- This skill DECIDES and PLANS; it does not implement. Stop at the plan write.
- Always read the real trevor legacy / Trevor code before claiming what either does - prior art and current state are
  evidence, not guesses.
- The decision gate is the point of the skill: the value is deciding the right shape together before
  it becomes plan debt. Never front-run the user's decision by writing the plan early.
- The planner owns lifecycle integrity. Do not bypass `plan-db`, `check-progress`, or convergence checks when
  writing plan or progress-report files.
- **Plan docs go on `main`, committed through a throwaway `main` worktree - never by switching the
  shared checkout's branch.** A session may be mid-implementation on the current branch; switching it,
  even briefly, changes its branch without its knowledge and risks colliding with its uncommitted work.
  `AGENTS.md` holds plan *policy*, not a per-plan index, so update it only when the policy itself
  changes; record new shared vocabulary in `CONTEXT.md`.
- **Number by decimal off the work in flight.** A new plan defaults to the next decimal under the plan
  currently being implemented (`03` -> `03.1`), or under a dependency plan when one exists (`40` -> `40.1`).
  Never renumber existing plans.
- **Thread the new plan into the downstream plans it changes.** Placing a plan is not finished until the
  *later* plans whose assumptions it invalidates or extends are accommodated (forward-dependency bullet,
  note/marker, RED/GREEN tasks where real work is implied, recorded decision, re-converged). Any plan
  with a live `feat/<NN>` branch/worktree is SKIPPED and surfaced, never edited on `main`. Be
  conservative: accommodate concrete interactions only, and say what you skipped.
- RED/GREEN/REFACTOR milestone tasks are mandatory for new progress-report implementation work. A generic
  product checklist is drift unless each behavior is tied to test-first RED items, matching GREEN
  implementation items, and REFACTOR cleanup.
- Keep the comparison specific about gaps (what Trevor lacks, what trevor legacy got wrong) rather than just listing
  features.
