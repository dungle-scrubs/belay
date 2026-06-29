# Serial Worktree Implement - Progress Report

## Summary

- **Current cutoff blockers:** 35
- **Completed current work:** 3
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Run Entry and Handoff

## Completed Current State / Hard Dependencies

- [x] Managed worktree engine shipped (D-091): `WorktreeManager.create / createFromCwd / resolveSwitch / mergeBack / remove / reconcile / diff` plus host commands `/worktree-new | /worktree-switch | /worktree-merge | /worktree-delete | reconcile`.
- [x] Handoff entry shipped: `apps/agent-host/src/handoff-flow.ts` - reused to spawn the durable serial run as a fresh session.
- [x] `planner` skill implement-mode available - each queued plan is implemented through it inside its tree.
- Soft dependency (not a current blocker): `.plans/01-managed-worktree-hardening` cwd advisory lock makes a Trevor-owned mutating worktree safe while the user works on `main` by hand - see implementation.md § 0.

## Current Cutoff Blockers

### M1 - Run Entry and Handoff

- [ ] RED: Cover that a conversational trigger parses an ordered queue of one-or-more plan specs and hands off to a dedicated durable serial run, freeing the launching session.
- [ ] GREEN: Implement the entry over `handoff-flow` that spawns the durable serial-run session bound to the plan queue.
- [ ] RED: Cover that the durable run has a stable id and is re-openable, and that the launching session is not blocked on it.
- [ ] GREEN: Implement durable run identity + reopen.
- [ ] REFACTOR: Keep `handoff-flow` generic; the serial run is just a consumer.

### M2 - Create + Enter a Managed Worktree

- [ ] RED: Cover create + enter of a managed worktree for a queued plan via the existing `WorktreeManager` (`/worktree-new` + `/worktree-switch`), acquiring the 01 cwd lock.
- [ ] GREEN: Implement the create + enter step reusing `createFromCwd` + `resolveSwitch`; add no new git plumbing.
- [ ] RED: Cover that a failed create/enter (cwd lock held, dirty base) surfaces a typed error and halts the run.
- [ ] GREEN: Implement the failure path.
- [ ] REFACTOR: Route entirely through the shipped managed lifecycle; do not duplicate worktree logic.

### Gate 1 -> 2

- [ ] A single queued plan can be created and entered as a managed worktree from a durable run.
- [ ] The run is durable and re-openable; the launching session is freed.
- [ ] Create/enter failure halts the run with a typed, surfaced reason.

### M3 - Implement via planner implement-mode

- [ ] RED: Cover running `planner` implement-mode against the plan inside its worktree, with the run observing completion vs failure.
- [ ] GREEN: Implement the implement step (invoke planner implement-mode scoped to the worktree).
- [ ] RED: Cover that an implementation ending red (tests failing) is recorded as not-green.
- [ ] GREEN: Implement green/red detection.
- [ ] REFACTOR: Keep the planner invocation explicit and its result visible in the run journal.

### M4 - Commit, Merge-back, and Cleanup with a Green Gate

- [ ] RED: Cover the disposition - on green + clean, commit -> `mergeBack` -> `remove` (delete tree + release cwd lock); on red/conflict/dirty, STOP and surface, leave the tree intact.
- [ ] GREEN: Implement disposition reusing `/worktree-merge` + `/worktree-delete` + `diff` for the inspect-before-merge view.
- [ ] RED: Cover that a merge conflict halts the run with the tree + branch preserved and a clear reason.
- [ ] GREEN: Implement conflict handling.
- [ ] REFACTOR: Centralize the green-gate decision so it is the single place that authorizes merge + delete.

### Gate 2 -> 3

- [ ] One plan runs end-to-end: create -> implement -> green -> merge -> delete.
- [ ] A red or conflicted plan halts the run safely with its tree + branch preserved.
- [ ] Merge + delete happen only through the single green gate.

### M5 - Serial Loop Over N Plans + Resume

- [ ] RED: Cover that multiple queued plans run strictly serially - the next plan's tree is created only after the prior tree is merged + deleted (never two mutating trees at once).
- [ ] GREEN: Implement the serial driver loop over the plan queue.
- [ ] RED: Cover resume mid-sequence - after a crash/reopen the run continues from the next un-disposed plan and never re-merges a completed one.
- [ ] GREEN: Implement resume from the run journal.
- [ ] REFACTOR: Factor the per-plan lifecycle as a single reusable unit that `46-worktree-fleet` can call per leaf (the precursor seam) - no behavior change.

### Done Gate

- [ ] A durable serial run implements a queue of plans one tree at a time, auto-merging + deleting each green tree and halting safely on the first red/conflict/dirty tree.
- [ ] The run is resumable and re-openable; no two mutating worktrees ever exist concurrently.
- [ ] The driver reuses the shipped `WorktreeManager` + `/worktree-*` commands + `handoff-flow` + `planner` implement-mode, with no new git plumbing and no dependency on `21`/`12`/`15`.
- [ ] The per-plan lifecycle is factored so `46-worktree-fleet` can later parallelize it per leaf.

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
