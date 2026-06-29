# Serial Worktree Implement - Implementation Plan

## 0. Hard Dependencies

- [x] Managed worktree engine shipped (D-091): `WorktreeManager.create / createFromCwd /
  resolveSwitch / mergeBack / remove / reconcile / diff` (`apps/agent-host/src/worktrees/`) and the
  host commands `/worktree-new | /worktree-switch | /worktree-merge | /worktree-delete | reconcile`
  (`apps/agent-host/src/main.ts`). This plan reuses that lifecycle as-is; it adds no new git plumbing.
- [x] Handoff entry shipped: `apps/agent-host/src/handoff-flow.ts` (spawn a new host/session and move
  on). Reused to spawn the durable serial run as a fresh session. <!-- D-002 -->
- [x] `planner` skill implement-mode (`~/.agents/skills/planner`). Each queued plan is implemented
  through it, inside its own worktree.
- [ ] `.plans/10.1-managed-worktree-hardening` - the cwd-path advisory lock. **Soft dependency, not a
  blocker:** the serial run can operate without it, but 10.1 is what makes a Trevor-owned mutating
  worktree safe while the user does manual work on `main` concurrently - which is the whole motivation
  for this feature. <!-- D-004 -->

This plan is the **serial precursor of `.plans/55-worktree-fleet`** <!-- D-001 -->. It owns the same
per-plan worktree lifecycle (create -> implement -> commit -> merge-back -> delete) but runs it
**strictly one tree at a time**, with **no** dependency on `.plans/54-workflows-runtime` (the Effect
engine), `.plans/47-bounded-child-takeover` (parallel leaves), or `.plans/50-forkable-sessions-lineage`
(the run is a fresh session, not a fork). `55` later generalizes this same lifecycle to N>1 in parallel.

## 1. Architecture

The Serial Worktree Implement run turns a request - *"implement these plans, each in its own worktree,
one at a time, and merge each back when it is green"* - into a single durable, resumable run. It is a
thin **autonomous driver** layered on top of already-shipped pieces; it invents no new worktree, merge,
or session machinery.

### Flow <!-- D-001 -->

```
user request (their session)
  -> parse: an ordered queue of plans to implement        (each "plan" = an existing .plans/NN[.n])
  -> CONFIRM the queue                                     (default gate; revisitable)
  -> handoff: spawn a dedicated DURABLE serial run         (reuse handoff-flow; launching session freed)
  -> [serial driver loop]  for each plan, strictly one at a time:
       1 create + enter a managed worktree                 (/worktree-new + /worktree-switch; 10.1 cwd lock)
       2 implement the plan in the tree                     (planner implement-mode)
       3 commit
       4 green + clean?  -> /worktree-merge -> /worktree-delete   (auto disposition)
          red / conflict / dirty?  -> STOP and surface, leave tree intact   (no auto-delete)
  -> the next plan's tree is created ONLY after the prior tree is merged + deleted
  -> aggregate: per-plan outcome + summary                 (durable, re-openable)
```

The orchestration is **deterministic and serial**; the model re-enters only to parse the request and to
do the per-plan implementation. There is never more than one mutating worktree alive at a time, which is
exactly what lets the user keep working on `main` by hand in parallel.

### Disposition <!-- D-003 -->

| Tree outcome | Action |
|---|---|
| green + clean working tree | auto: commit -> `mergeBack` -> `remove` (delete tree, release cwd lock) |
| implementation red (tests failing) | STOP the run, surface; leave tree + branch intact for inspection |
| merge conflict | STOP the run, surface the conflict; leave tree + branch intact |
| dirty / unexpected state | STOP the run, surface; never auto-delete |

This intentionally differs from `55`'s default disposition ("leave branches, human merges"): the serial
run's contract is "merge each green tree automatically, halt on the first one that is not green."

### Key Constraints

| Constraint | Impact |
|---|---|
| Reuse the shipped managed engine | No new `git worktree` plumbing; the run only orchestrates existing `WorktreeManager` / host commands. |
| Strictly serial | At most one mutating worktree exists at any time; the next is created only after the prior is disposed. |
| Durable + resumable | The run is a handoff-spawned session; a crash/reopen continues from the next un-disposed plan, never re-merging a completed one. |
| Auto-merge only when green + clean | A non-green or conflicted tree halts the run and is preserved, never silently merged or deleted. |
| No `54`/`47`/`50` dependency | The serial driver stands alone on the shipped engine + handoff-flow + planner implement-mode. |

### Boundaries

- **WorktreeManager / host worktree commands** own create/switch/merge/delete/reconcile. The serial
  driver calls them; it does not reimplement them.
- **handoff-flow** owns spawning the durable run session. The serial driver is a consumer; handoff-flow
  stays generic.
- **planner implement-mode** owns the actual code changes inside a tree. The driver invokes it and reads
  its green/red result; it does not embed implementation logic.
- **The serial driver** owns only: the plan queue, the one-at-a-time sequencing, the green gate, the
  disposition decision, and the resumable run journal.
- The per-plan lifecycle is factored as **one reusable unit** so `55-worktree-fleet` can later call it
  per worker leaf - the serial driver is the seam `55` parallelizes. <!-- D-005 -->

### Observability

- structured run-journal entries per plan: queued -> tree-created -> implementing -> committed ->
  merged/deleted, or halted-with-reason
- the halt reason (red tests / merge conflict / dirty) is explicit and points at the preserved tree +
  branch so the user can inspect or finish by hand
- the durable run is re-openable by id and shows per-plan outcome + an aggregate summary
- a started tree that the run can no longer account for is surfaced through the existing `reconcile`
  path rather than silently leaked

---

## Phases

### Phase 1: Durable serial run foundation

**Goal:** a request becomes a dedicated, durable, resumable run that can create and enter exactly one
managed worktree for a queued plan.

**Gate from previous:** hard dependencies are in place (shipped engine, handoff-flow, planner
implement-mode).

#### M1: Run Entry and Handoff

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Cover that a conversational trigger parses an ordered queue of one-or-more plan specs and
     hands off to a dedicated durable serial run, freeing the launching session.
  2. GREEN: Implement the entry over `handoff-flow` that spawns the durable serial-run session bound to
     the plan queue.
  3. RED: Cover that the durable run has a stable id and is re-openable, and that the launching session
     is not blocked on it.
  4. GREEN: Implement durable run identity + reopen.
  5. REFACTOR: Keep `handoff-flow` generic; the serial run is just a consumer.

#### M2: Create + Enter a Managed Worktree

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Cover create + enter of a managed worktree for a queued plan via the existing
     `WorktreeManager` (`/worktree-new` + `/worktree-switch`), acquiring the 10.1 cwd lock.
  2. GREEN: Implement the create + enter step reusing `createFromCwd` + `resolveSwitch`; add no new git
     plumbing.
  3. RED: Cover that a failed create/enter (cwd lock held, dirty base) surfaces a typed error and halts
     the run.
  4. GREEN: Implement the failure path.
  5. REFACTOR: Route entirely through the shipped managed lifecycle; do not duplicate worktree logic.

### Gate 1 -> 2

- [ ] A single queued plan can be created and entered as a managed worktree from a durable run.
- [ ] The run is durable and re-openable; the launching session is freed.
- [ ] Create/enter failure halts the run with a typed, surfaced reason.

### Phase 2: Implement-in-tree and disposition

**Goal:** one plan goes end-to-end inside its tree - implemented, committed, and either auto-merged or
safely halted.

**Gate from previous:** Gate 1 -> 2 passes.

#### M3: Implement via planner implement-mode

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Cover running `planner` implement-mode against the plan inside its worktree, with the run
     observing completion vs failure.
  2. GREEN: Implement the implement step (invoke planner implement-mode scoped to the worktree).
  3. RED: Cover that an implementation ending red (tests failing) is recorded as not-green.
  4. GREEN: Implement green/red detection.
  5. REFACTOR: Keep the planner invocation explicit and its result visible in the run journal.

#### M4: Commit, merge-back, and cleanup with a green gate

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Cover the disposition - on green + clean, commit -> `mergeBack` -> `remove` (delete tree +
     release cwd lock); on red/conflict/dirty, STOP and surface, leave the tree intact.
  2. GREEN: Implement disposition reusing `/worktree-merge` + `/worktree-delete` + `diff` for the
     inspect-before-merge view.
  3. RED: Cover that a merge conflict halts the run with the tree + branch preserved and a clear reason.
  4. GREEN: Implement conflict handling.
  5. REFACTOR: Centralize the green-gate decision so it is the single place that authorizes merge +
     delete.

### Gate 2 -> 3

- [ ] One plan runs end-to-end: create -> implement -> green -> merge -> delete.
- [ ] A red or conflicted plan halts the run safely with its tree + branch preserved.
- [ ] Merge + delete happen only through the single green gate.

### Phase 3: Serial driver and resume

**Goal:** a queue of plans is implemented strictly one tree at a time, and the run resumes mid-sequence
after a crash or reopen.

**Gate from previous:** Gate 2 -> 3 passes.

#### M5: Serial loop over N plans + resume

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Cover that multiple queued plans run strictly serially - the next plan's tree is created only
     after the prior tree is merged + deleted (never two mutating trees at once).
  2. GREEN: Implement the serial driver loop over the plan queue.
  3. RED: Cover resume mid-sequence - after a crash/reopen the run continues from the next un-disposed
     plan and never re-merges a completed one.
  4. GREEN: Implement resume from the run journal.
  5. REFACTOR: Factor the per-plan lifecycle as a single reusable unit that `55-worktree-fleet` can call
     per leaf (the precursor seam) - no behavior change. <!-- D-005 -->

### Done Gate

- [ ] A durable serial run implements a queue of plans one tree at a time, auto-merging + deleting each
      green tree and halting safely on the first red/conflict/dirty tree.
- [ ] The run is resumable and re-openable; no two mutating worktrees ever exist concurrently.
- [ ] The driver reuses the shipped `WorktreeManager` + `/worktree-*` commands + `handoff-flow` +
      `planner` implement-mode, with no new git plumbing and no dependency on `54`/`47`/`50`.
- [ ] The per-plan lifecycle is factored so `55-worktree-fleet` can later parallelize it per leaf.

---

## Non-Goals

- Parallel / concurrent worktrees - that is `.plans/55-worktree-fleet` on `.plans/54-workflows-runtime`.
- The Effect workflow runtime (`.plans/54`).
- Bounded-child fan-out (`.plans/47`) and per-tree verifier/audit leaves (`.plans/53`).
- A richer disposition policy (review queue, per-tree approval UI) beyond auto-merge-on-green /
  stop-and-surface - `55` owns that.
- Session forking / lineage (`.plans/50`) - the serial run is a fresh durable session, not a fork.

---

## Decisions

Canonical decisions are in `.plans/10.2-serial-worktree-implement/plan.db`. Query with:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "10.2-serial-worktree-implement"
```

Key decisions referenced in this document use `<!-- D-NNN -->` markers.
