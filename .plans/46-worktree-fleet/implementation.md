# Worktree Fleet - Implementation Plan

## 0. Hard Dependencies

- [ ] `.plans/21-workflows-runtime` - the engine (authored + hardened, **not yet implemented**). The
  fleet **is** a built-in workflow on it (`worktree-fleet`), using `21`'s `agent()` leaves, worktree
  isolation, journaling, budget, and background-run lifecycle. 46's parallel writers gate on `21`
  **through M6** (Gate 3->4: worktree-isolated write-capable leaves), not merely on `21`'s engine
  core. <!-- D-010 -->
- [x] `.plans/01-managed-worktree-hardening` - **merged** (completed, removed from `.plans/`): the
  `WorktreeManager` + cwd-path advisory lock. `01` prevents worktree-path **collision** but does
  **not** route a working directory; the load-bearing prerequisite for N concurrent mutating trees is
  `21`/M6's **per-leaf cwd routing through the tool boundary** (net-new, **decided in-process**,
  `21/D-024`), which 46 inherits transitively via `21`. <!-- D-010 -->
- [x] (was `.plans/12-bounded-child-takeover`) - the bounded-child runtime is **folded into `21`**'s hardened `agent()` leaf (plan 12 dropped); covered by the `21` dependency above, no separate plan. <!-- D-009 -->
- [x] `.plans/15-forkable-sessions-lineage` (supporting) - **merged**: the durable fleet run is a session.
- [ ] `.plans/45-subagent-variants` (supporting; **not yet implemented**) - `45`/M2 retains the
  **verifier** leaf shape the audit phase (M4) reuses. M4 falls back to a `code-review`/`simplify`
  `agent()` leaf when `45`/M2 is unbuilt, so 46 is buildable **without** `45`. <!-- D-015 -->
- [x] Detached durable-run lifecycle is **owned by `21`** (`21/D-018`): the fleet **rides `21`'s run
  lifecycle directly** - `21` spawns the durable, write-capable, resumable run session (via `15`) and
  notifies the launcher on completion (distinct from `delegated.to`). 46 no longer drives
  `handoff-flow.ts` spawn mechanics itself (contrast the interactive `/handoff`, which switches the
  browser and retires the source). <!-- D-013 --> <!-- D-022 -->
- [x] Existing worktree commands `/worktree-new|switch|merge|delete|reconcile`
  (`apps/agent-host/src/worktrees/commands.ts`, `makeWorktreeCommands`; extracted from `main.ts` in
  plan 22.2) - reused by the disposition step.
- [x] Existing `planner` skill (`~/.agents/skills/planner`) - each worker runs it in **implement mode**,
  **code-only** (D-011) and in **autonomous/AFK opt-out** (D-012).
- [x] **Reorg (plans 22.1/22.2) - merged:** `handoff-flow.ts` now lives under `handoff/`; the
  `/worktree-*` command handlers moved out of `main.ts` into `worktrees/commands.ts`. This plan targets
  the **post-reorg** paths above. <!-- D-018 --> <!-- D-008 -->

## 1. Architecture

The Worktree Fleet turns a single request - *"make N worktrees that each implement a specific plan and
audit each individually"* - into a durable, parallel, audited run. It is three things layered:

1. a **built-in `worktree-fleet` workflow** on `21` (the orchestration),
2. a **durable, conversationally-entered run** (handoff-owned, resumable), and
3. a **disposition policy** for what happens to the finished trees.

The orchestration itself is **fixed and deterministic** (developer-authored, per `21`'s authoring
model #1); the model re-enters only to parse the request and to do per-tree implementation/audit.
<!-- D-001 -->

### Flow <!-- D-002 -->

```
user request (their session)
  -> parse: N {branch, plan, worktree} specs        (small LLM leaf; "plan" = an existing .plans/NN)
  -> CONFIRM the specs                                (default gate; revisitable)
  -> handoff: spawn a dedicated DURABLE fleet run     (DETACHED spawn - no switch/retire; launcher survives)
  -> [worktree-fleet workflow on 21]
       phase "implement":  fan out N worker leaves    (isolation:'worktree', write-capable)
                           each runs `planner` implement-mode (code-only, AFK) in its fleet branch/tree
       phase "audit":      after each worker, a verifier leaf reviews that tree's diff   (flat)
  -> aggregate: per-tree report + summary             (durable, re-openable)
  -> disposition: leave branches + report             (default; human merges via /worktree-merge|delete)
```

### Workers = the planner, parallelized <!-- D-003 -->

Each worker leaf is a write-capable, worktree-isolated `21` `agent()` that invokes the **planner skill
in implement mode** against a target **numbered plan** (`.plans/NN`). The fleet is therefore
"parallelize the planner's implement mode across N managed worktrees, then audit each." Plan input is a
list of existing plan refs (resolved against the plan registry), not freeform prompts; specs must target
**distinct** plans (no two workers on one `.plans/NN`).

**Code-only planner contract.** The worker runs the planner to implement + test + **commit on the
fleet-provisioned branch in its own worktree** - nothing more. The trevor-v2 planner git ritual
(`AGENTS.md` "a branch per plan": create `feat/<plan>`, `git rm -r` the `.plans/NN` dir on completion,
`git checkout main` + ff-merge) is **suppressed**: branch creation, plan-dir removal, and merge-to-base
are owned by the **fleet** (`01`'s `WorktreeManager` provisions the branch/tree; the disposition step
merges/discards via `worktrees/commands.ts`). Running the full ritual in N parallel trees would race
`git checkout main` across shared worktrees and write to base autonomously - exactly what "safe by
default" forbids. <!-- D-011 -->

**One flat leaf, budgeted for a whole plan.** The planner is invoked in **autonomous/AFK opt-out** mode
(no per-milestone confirm prompts, which a headless leaf cannot answer). One worker leaf runs the
planner's implement loop to completion as a **single flat `21` leaf** (no sub-delegation, per `21`/D-005) -
concretely `21`'s **multi-turn worker leaf** (`21`/D-017), since a whole plan cannot complete in one turn
(a single `21` turn is bounded by `EMERGENCY_MAX_STEPS = 256` and forced synthesis at 0.8 of the context
window). Its **per-leaf token + step budget is sized for a whole-plan implementation** via `21`'s
per-`agent()` caps (`opts.tokenBudget`/`opts.stepBudget`, `21`/D-020), and the shared pool is sized for
the concurrency cap (~4-5), so a heavyweight leaf is not budget-cancelled mid-plan and worst-case
overshoot stays `(cap x per-leaf cap)` per `21`/D-013. Workers default to a **cloud model** (local pins
serialise by design, see D-020). <!-- D-012 --> <!-- D-021 --> <!-- D-020 -->

### Flat audit, orchestrator-owned <!-- D-004 -->

After each worker completes, the workflow schedules a separate **auditor/verifier** leaf over that
tree's diff. The auditor is the `45`/M2 **verifier** leaf shape when `45`/M2 is built; otherwise it is a
`code-review`/`simplify` `agent()` leaf - so M4 is **buildable without `45`** (`45` is supporting, not
hard). Findings attach to the tree's result. The worker does **not** spawn its own auditor (v1 is flat,
per `21`); the orchestration owns the audit. <!-- D-015 -->

### Aggregation + disposition <!-- D-005 -->

The run aggregates a per-tree record - `{ branch, status, diffstat, audit verdict + findings,
conflict-with-base }` - plus a top-line summary, stored in the durable run record and re-openable. The
record also surfaces each worker's **final progress-report summary + child session id + branch**, so a
planner-leaf failure is diagnosable from the report without checking out the branch. Because the worker's
milestone/gate state lives in its worktree's `plan.db`, **not** `21`'s journal, the report is a
**projection of `21`'s journal JOINED with a per-worker `plan.db` read**: on a graceful planner failure
the worker returns a **structured partial-failure result** (its summary journaled as the leaf result),
and on a hard failure it rides `21`'s optional `leaf-failed` `detail` (`21/D-022`) plus the `plan.db`
read. <!-- D-017 --> <!-- D-019 -->

Disposition (default **leave-branches + report**): the fleet stops; the human merges or discards each
tree via the existing `/worktree-merge` / `/worktree-delete`. Recorded alternatives: **PR-per-tree**
(behind a **configured remote**; posts audit findings; **falls back to leave-branches when no remote is
configured**) and **auto-merge clean + passing** (audit becomes a hard gate; writes to base
autonomously). Auto-merge **serialises** the merges and **re-verifies each tree against the post-merge
base** before accepting the next - a per-tree "clean" verdict was computed against the pre-fleet base, so
an earlier merge can invalidate a later tree (textual or semantic conflict); auto-merge re-diffs and
re-runs the gate on the merged result, not the isolated tree. `fire-immediately` **+** auto-merge (no
human checkpoint anywhere before base is written) is an explicit, loudly-flagged combination, never a
silent default. <!-- D-014 -->

### Failure, concurrency, durability <!-- D-006 -->

- A worker that fails or stalls is **marked failed** (via `21`'s typed `leaf-failed` + structured cause,
  `21`/D-012), siblings continue, and it is surfaced in the report (logged, never silently dropped);
  **at most one auto-retry**. The retry is a **second `agent()` leaf at a new call ordinal**, fired
  deterministically when the first leaf's **journaled** result is a typed failure - never an in-leaf
  re-roll - so a resumed run reproduces the same retry decisions under `21`'s **per-invocation**
  ordinal-keyed replay (`21`/D-009, `21`/D-019 - the retry is a second `agent()` call at its **own**
  ordinal, distinct from the worker's, not a collision on the worker's slot). <!-- D-016 -->
- Concurrency cap is configurable (default ~4-5; "five" fits comfortably); overflow queues on `21`'s
  scheduler. A budget policy sized for heavyweight planner leaves is set per D-012.
- The run is a **detached** durable background session **owned by `21`** (`21/D-018`): the fleet **rides
  `21`'s run lifecycle directly** rather than building its own from `handoff-flow` (`D-022`). The
  launching session is **not** switched or retired (contrast the interactive `/handoff`, which switches
  the browser and retires the source); it survives the launching browser/tab closing, is resumable from
  `21`'s journal, and the launcher is **notified on completion** (distinct from `delegated.to`) via
  `21`'s run lifecycle. <!-- D-013 --> <!-- D-022 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Fixed orchestration | The workflow is developer-authored; the model only parses + implements + audits. |
| Confirm before writes | Default gate shows the N specs before any tree/agent is created. |
| Durable run | Handoff-owned; survives tab close; resumable. |
| Plan refs, not prompts | Workers target existing `.plans/NN` plans via the planner. |
| Flat audit | The orchestration schedules the auditor; workers don't self-audit. |
| Safe by default | Default disposition writes nothing to base branches. |

### Boundaries

- **`apps/agent-host`** owns the `worktree-fleet` workflow module, the request-parse step, the confirm
  gate, the handoff entry, and the disposition executor.
- **`21`** owns execution (leaves, isolation, journaling, budget) **and the detached durable-run
  lifecycle** (spawn via `15` + run-completion notify distinct from `delegated.to`, `21/D-018`).
- **`01`** owns worktree creation/locking (`WorktreeManager`); disposition reuses the existing
  `/worktree-*` commands in `worktrees/commands.ts` (`makeWorktreeCommands`).
- **`apps/web`** reuses existing surfaces (session sidebar activity, `/worktree` modal status); **no
  new dashboard**.

### Observability

The run view (reusing `21`'s) shows the implement and audit phases, per-tree status, and the
aggregated report. Per-tree failures and audit verdicts are typed and surfaced. Worker sessions are
inspectable as ordinary sessions; the `/worktree` modal shows live per-tree state.

## 2. Relationship to existing plans

- **Consumes `21`** (engine) - the fleet is its first real workload and proving ground.
- **Realizes the application-half of `45`/M4** (mutating background agents): the merge/reconcile and
  user-approval concerns around write-capable worktree agents live here; the engine-half (isolation +
  lifted read-only) is in `21`.
- Uses the **verifier** that `45` retains (M2) as its auditor leaf **when built**; otherwise a
  `code-review`/`simplify` leaf (M4 does not hard-block on `45`; see §0 and D-015).

## 3. Phases

### Phase 1: Spec parse, confirm, handoff entry

**Goal:** a request becomes N approved specs and a dedicated durable run.

**Gate from previous:** `21` can run a built-in workflow in the background.

#### M1: Request -> spec parse

- **Dependencies:** `.plans/21-workflows-runtime`
- **Effort:** M
- **Tasks:**
  1. RED: tests that a NL request -> N `{branch, plan, worktree}` specs; plan refs resolve to existing
     `.plans/NN`; unknown/ambiguous plan refs are rejected.
  2. GREEN: a parse step (small LLM leaf) + spec schema + validation against the plan registry.
  3. REFACTOR: keep parse separate from execution.

#### M2: Confirm gate + handoff

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: tests that the specs are presented for approval **before** any tree/agent is created; approve
     -> a dedicated durable fleet run is spawned; reject -> nothing is created.
  2. GREEN: the confirm-spec-first gate + **enter the run by riding `21`'s detached durable-run lifecycle
     directly** (`21/D-018`) - `21` spawns the durable session (via `15`), the launcher is **not**
     switched/retired and survives, and is notified on completion (distinct from `delegated.to`). 46 no
     longer drives `handoff-flow` spawn mechanics itself. <!-- D-013 --> <!-- D-022 -->
  3. RED: tests for the `fire-immediately` config variant.
  4. GREEN: config-driven gate (confirm vs fire-immediately; default confirm).
  5. REFACTOR: keep the gate policy separate from the workflow body.

### Gate 1->2

- [ ] A request yields validated specs bound to real plans.
- [ ] No tree/agent is created before approval (in the default gate).
- [ ] The run is owned by a dedicated durable session via handoff.

### Phase 2: The `worktree-fleet` workflow

**Goal:** N plans implement in parallel, each in its own audited tree.

**Gate from previous:** the run is durable and entered safely.

#### M3: Worker leaves (planner implement in a tree)

- **Dependencies:** M2; `.plans/21-workflows-runtime` **through M6** (Gate 3->4: worktree-isolated
  write-capable leaves + per-leaf cwd routing); `.plans/01-managed-worktree-hardening` (**merged** -
  cwd-lock; collision-only, not cwd routing)
- **Effort:** L
- **Tasks:**
  1. RED: tests that each spec -> a write-capable worktree leaf running `planner` implement-mode against
     its plan; isolated; non-racing across siblings.
  2. GREEN: the built-in `worktree-fleet` workflow - an "implement" phase fanning out worker leaves
     (`isolation:'worktree'`, `21`'s **multi-turn** leaf on a **cloud** model with a per-`agent()`
     whole-plan budget) on `21`; each invokes the planner in **code-only, AFK** mode, committing to its
     fleet-provisioned branch (no branch/merge/plan-dir ritual; see D-011/D-012/D-021/D-020). <!-- D-021 --> <!-- D-020 -->
  3. RED: failure/stall tests - a failed worker is marked failed, siblings continue, `<=1` retry.
  4. GREEN: fail-soft + bounded retry (a **new-ordinal** second leaf, deterministic on the journaled
     failure; D-016) + a structured per-worker result.
  5. REFACTOR: keep worker policy in the workflow, not the engine.

#### M4: Flat audit phase

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: tests that after each worker an auditor leaf (`45`/M2 verifier / `code-review`) reviews that
     tree's diff and attaches a verdict + findings.
  2. GREEN: the "audit" phase (flat; orchestrator-owned).
  3. REFACTOR: reuse the verifier leaf shape from `45`/M2 when built; else a `code-review`/`simplify`
     leaf (D-015).

### Gate 2->3

- [ ] N plans implement in parallel, each in an isolated tree, with bounded retry on failure.
- [ ] Each tree carries an audit verdict + findings.

### Phase 3: Aggregation + disposition

**Goal:** a re-openable report, and a safe default for what happens next.

**Gate from previous:** workers and audits produce structured per-tree results.

#### M5: Aggregation report

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: tests for a per-tree record `{ branch, status, diffstat, audit verdict + findings,
     conflict-with-base, worker-progress-summary, child-session-id }` + summary, stored in the durable
     run record and re-openable; a planner-leaf failure is diagnosable from the report without checking
     out the branch - the report is a **projection of `21`'s journal JOINED with a per-worker `plan.db`
     read**, the worker returning a **structured partial-failure result** on graceful failure (D-017, D-019). <!-- D-019 -->
  2. GREEN: aggregation + durable run report (a projection of `21`'s journal joined with each worker's
     `plan.db`). <!-- D-019 -->
  3. REFACTOR: keep the report derived, not separately authored.

#### M6: Disposition policy

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: tests for the default **leave-branches + report** (no base-branch writes); **PR-per-tree**
     (behind a configured remote; **falls back to leave-branches with no remote**); and **auto-merge
     clean + passing** (audit is a hard gate) that **serialises merges and re-verifies each tree against
     the post-merge base** before accepting the next (D-014).
  2. GREEN: a disposition executor reusing the `/worktree-*` commands in `worktrees/commands.ts`
     (`makeWorktreeCommands`); the PR path behind a configured remote; auto-merge serialised +
     re-verified.
  3. REFACTOR: keep disposition policy-driven and revisitable.

### Gate 3->4

- [ ] The report is durable and re-openable.
- [ ] Default disposition writes nothing to base branches; alternatives are opt-in.

### Phase 4: Presentation + e2e

**Goal:** the run is observable through existing surfaces and proven end-to-end.

**Gate from previous:** the full run produces a report and honors disposition.

#### M7: Reuse existing surfaces

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: web tests that the N worker sessions show as sidebar rows with activity bars, and the
     `/worktree` modal shows per-tree status including the audit verdict.
  2. GREEN: wire fleet/worktree status into the existing sidebar + `/worktree` modal; the fleet run is
     resumable.
  3. REFACTOR: no new dashboard surface.

#### M8: Hermetic e2e

- **Dependencies:** M7
- **Effort:** L
- **Tasks:**
  1. RED: a hermetic e2e - request -> confirm -> N trees -> planner-implement -> audit -> report ->
     leave-branches, against the fake provider.
  2. GREEN: the full fleet loop e2e in the `e2e/` workspace.

### Done Gate

- [ ] One request produces N audited worktrees + a durable, re-openable report.
- [ ] Default disposition leaves branches untouched on base; merge stays a human action.
- [ ] The run survives a tab close and resumes.
- [ ] Unit, web, integration, and hermetic e2e are green.

## 4. Non-Goals

<!-- D-007 -->

- **Tournament mode** - N competing implementations of the *same* thing, ranked. This plan is N
  *independent* plans. Possible future variant.
- **A dedicated multi-run dashboard UI** (split view of N transcripts) - reuse existing surfaces.
- **Model-authored fleet orchestration** - the fleet is a fixed, developer-authored workflow; the
  model only parses the request and does per-tree implementation/audit.
- **Auto-merge as the default** - the default writes nothing to base branches.

## 5. Decisions

Canonical decisions are in `.plans/46-worktree-fleet/plan.db` (D-001..D-022). Key decisions use
`<!-- D-NNN -->` markers above; a bare `D-NNN` marker denotes **this** plan's ledger, and references to
another plan's ledger are namespaced (e.g. `21`/D-009, `21`/D-012, `21`/D-017, `21`/D-018, `21`/D-020,
`delegation`/D-047) so they are never mistaken for this plan's decisions.

D-019..D-022 land the reverse-audit accommodations to `21`'s consumer-side hardening: the report is a
`21`-journal projection joined with each worker's `plan.db` (D-019), workers default to cloud models
(D-020), the whole-plan worker rides `21`'s multi-turn leaf (D-021), and the fleet rides `21`'s
detached durable-run lifecycle directly (D-022).
