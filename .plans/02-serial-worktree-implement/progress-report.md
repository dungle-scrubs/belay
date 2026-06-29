# Serial Worktree Implement - Progress Report

## Summary

- **Current cutoff blockers:** 0
- **Completed current work:** 38
- **Accepted/deferred follow-up:** 0
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** Complete - M1-M5 + gates + Done Gate green

> Build note: the deterministic orchestration the plan's boundary assigns to the serial driver - the
> plan queue (`queue.ts`), the durable resumable run journal (`journal.ts`), the one-tree-at-a-time
> loop + single green-gate disposition + resume (`driver.ts`), the worktree-manager-backed capabilities
> (`node.ts`), and the handoff entry (`entry.ts`) - is built and unit-tested (42 tests). It is wired
> into the host with three commands that **advance the durable journal in production**:
> `/serial-implement` (parse the queue, record the run, hand off to a dedicated session) and, in that
> run, `/serial-next <runId>` (host creates + enters the next plan's worktree -> `tree-created`) and
> `/serial-dispose <runId> [fail <reason>]` (host runs the single green gate: clean -> merge -> delete
> -> `merged`, or halt). The agent implements in the tree **between** those two host calls - the
> `SerialDriverCaps.implement` seam, fulfilled by the run session's agent per D-002 ("the model
> re-enters only to parse the request and to do the per-plan implementation"). The disposition is the
> single authorized merge+delete path, shared by the non-interactive `driveSerialRun` and the
> host-driven `disposeCurrentPlan` - the per-leaf lifecycle unit `46-worktree-fleet` parallelizes.

## Completed Current State / Hard Dependencies

- [x] Managed worktree engine shipped (D-091): `WorktreeManager.create / createFromCwd / resolveSwitch / mergeBack / remove / reconcile / diff` plus host commands `/worktree-new | /worktree-switch | /worktree-merge | /worktree-delete | reconcile`.
- [x] Handoff entry shipped: `apps/agent-host/src/handoff-flow.ts` - reused to spawn the durable serial run as a fresh session.
- [x] `planner` skill implement-mode available - each queued plan is implemented through it inside its tree.
- Soft dependency (not a current blocker): `.plans/01-managed-worktree-hardening` cwd advisory lock makes a Trevor-owned mutating worktree safe while the user works on `main` by hand - see implementation.md § 0.

## Current Cutoff Blockers

### M1 - Run Entry and Handoff

- [x] RED: Cover that a conversational trigger parses an ordered queue of one-or-more plan specs and hands off to a dedicated durable serial run, freeing the launching session. (`queue.test.ts`, `entry.test.ts`)
- [x] GREEN: Implement the entry over `handoff-flow` that spawns the durable serial-run session bound to the plan queue. (`entry.ts startSerialRun`; `main.ts /serial-implement` over `runDirectHandoff`)
- [x] RED: Cover that the durable run has a stable id and is re-openable, and that the launching session is not blocked on it. (`journal.test.ts` persistence/reopen; `entry.test.ts` handoff frees the session)
- [x] GREEN: Implement durable run identity + reopen. (`journal.ts` newSerialRun/saveRun/loadRun under `serial-runs.json`)
- [x] REFACTOR: Keep `handoff-flow` generic; the serial run is just a consumer. (`entry.ts` calls the unchanged `runDirectHandoff`; no handoff-flow edits)

### M2 - Create + Enter a Managed Worktree

- [x] RED: Cover create + enter of a managed worktree for a queued plan via the existing `WorktreeManager` (`/worktree-new` + `/worktree-switch`), acquiring the 01 cwd lock. (`node.test.ts` serialDriverCaps; `driver.test.ts` create path)
- [x] GREEN: Implement the create + enter step reusing `createFromCwd` + `resolveSwitch`; add no new git plumbing. (`node.ts nodeWorktreeOps.create` -> `createFromCwd` on `feat/<planId>`; the 01 cwd lock is acquired when the run host enters the tree)
- [x] RED: Cover that a failed create/enter (cwd lock held, dirty base) surfaces a typed error and halts the run. (`driver.test.ts` "a failed create/enter halts the run before any implement")
- [x] GREEN: Implement the failure path. (`driver.ts` halts with `create/enter failed: <error>`, run status halted, tree preserved)
- [x] REFACTOR: Route entirely through the shipped managed lifecycle; do not duplicate worktree logic. (`node.ts` maps every op onto `WorktreeManager`; no new git plumbing)

### Gate 1 -> 2

- [x] A single queued plan can be created and entered as a managed worktree from a durable run. (`node.test.ts` + `driver.test.ts`)
- [x] The run is durable and re-openable; the launching session is freed. (`journal.ts` + `entry.ts` handoff)
- [x] Create/enter failure halts the run with a typed, surfaced reason. (`driver.ts` halt branch, tested)

### M3 - Implement via planner implement-mode

- [x] RED: Cover running `planner` implement-mode against the plan inside its worktree, with the run observing completion vs failure. (`driver.test.ts` happy path + red path; the implement step is the injected `SerialDriverCaps.implement` seam)
- [x] GREEN: Implement the implement step (invoke planner implement-mode scoped to the worktree). (`SerialDriverCaps.implement(planId, sessionId)` - the seam the run session's agent fulfills via the planner skill, per D-002; the driver invokes it and reads green/red)
- [x] RED: Cover that an implementation ending red (tests failing) is recorded as not-green. (`driver.test.ts` "a red implementation halts and never merges or deletes")
- [x] GREEN: Implement green/red detection. (`driver.ts`: `impl.green` gates committed vs halted; halt reason carries the detail)
- [x] REFACTOR: Keep the planner invocation explicit and its result visible in the run journal. (each transition persists the journal: tree-created -> implementing -> committed / halted, asserted in `driver.test.ts`)

### M4 - Commit, Merge-back, and Cleanup with a Green Gate

- [x] RED: Cover the disposition - on green + clean, commit -> `mergeBack` -> `remove` (delete tree + release cwd lock); on red/conflict/dirty, STOP and surface, leave the tree intact. (`driver.test.ts` happy path + 3 halt branches)
- [x] GREEN: Implement disposition reusing `/worktree-merge` + `/worktree-delete` + `diff` for the inspect-before-merge view. (`node.ts` merge -> `mergeBack`, remove -> `remove`, inspect -> `summaries` dirty/conflict)
- [x] RED: Cover that a merge conflict halts the run with the tree + branch preserved and a clear reason. (`driver.test.ts` "a merge conflict halts with the tree preserved (never deleted)"; `node.test.ts` worktree merge failure)
- [x] GREEN: Implement conflict handling. (`driver.ts` halts on `merge.ok === false` before `remove`, tree + branch left intact)
- [x] REFACTOR: Centralize the green-gate decision so it is the single place that authorizes merge + delete. (`driveOnePlan`'s gate is the only path to `merge` -> `remove` -> `merged`)

### Gate 2 -> 3

- [x] One plan runs end-to-end: create -> implement -> green -> merge -> delete. (`driver.test.ts` + `node.test.ts`)
- [x] A red or conflicted plan halts the run safely with its tree + branch preserved. (`driver.test.ts` halt branches)
- [x] Merge + delete happen only through the single green gate. (`driveOnePlan` is the sole authorizer)

### M5 - Serial Loop Over N Plans + Resume

- [x] RED: Cover that multiple queued plans run strictly serially - the next plan's tree is created only after the prior tree is merged + deleted (never two mutating trees at once). (`driver.test.ts` call-order + "never holds two mutating worktrees at once" maxAlive === 1)
- [x] GREEN: Implement the serial driver loop over the plan queue. (`driver.ts driveSerialRun` over `nextPlan`)
- [x] RED: Cover resume mid-sequence - after a crash/reopen the run continues from the next un-disposed plan and never re-merges a completed one. (`driver.test.ts` resume-from-tree-created / committed / merged)
- [x] GREEN: Implement resume from the run journal. (`nextPlan` + phase-driven `driveOnePlan` skip already-done steps)
- [x] REFACTOR: Factor the per-plan lifecycle as a single reusable unit that `46-worktree-fleet` can call per leaf (the precursor seam) - no behavior change. (`driveOnePlan` is the unit; `serialDriverCaps`/`nodeWorktreeOps` the per-leaf seam)

### Done Gate

- [x] A durable serial run implements a queue of plans one tree at a time, auto-merging + deleting each green tree and halting safely on the first red/conflict/dirty tree. (`driveSerialRun` + disposition, tested)
- [x] The run is resumable and re-openable; no two mutating worktrees ever exist concurrently. (`journal.ts` reopen; `driver.ts` serial guarantee, tested)
- [x] The driver reuses the shipped `WorktreeManager` + `/worktree-*` commands + `handoff-flow` + `planner` implement-mode, with no new git plumbing and no dependency on `21`/`12`/`15`. (`node.ts` -> WorktreeManager; `entry.ts` -> handoff-flow; implement = planner seam; serial-run imports none of 21/12/15)
- [x] The per-plan lifecycle is factored so `46-worktree-fleet` can later parallelize it per leaf. (`driveOnePlan` + the caps seam)

## Accepted / Deferred Follow-Up

None.

## Superseded / Obsolete Checklist Debt

None.
