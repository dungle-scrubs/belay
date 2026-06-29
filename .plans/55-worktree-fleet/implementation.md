# Worktree Fleet - Implementation Plan

## 0. Hard Dependencies

- [ ] `.plans/54-workflows-runtime` - the engine. The fleet **is** a built-in workflow on it
  (`worktree-fleet`), using `54`'s `agent()` leaves, worktree isolation, journaling, budget, and
  background-run lifecycle.
- [ ] `.plans/10.1-managed-worktree-hardening` - the `WorktreeManager` + cwd-path advisory lock that make
  parallel, write-capable worker trees safe (transitively required by `54`'s isolated leaves; called
  out here because the fleet is the first real driver of N concurrent mutating trees).
- [ ] `.plans/47-bounded-child-takeover` - bounded-child runtime behind every leaf (transitive via `54`).
- [ ] `.plans/50-forkable-sessions-lineage` (supporting) - the durable fleet run is a session.
- [x] Existing handoff entry: `apps/agent-host/src/handoff-flow.ts` (spawn a new host for a new
  session and move on) - reused to hand the run off to a dedicated durable fleet session.
- [x] Existing worktree commands `/worktree-new|switch|merge|delete|reconcile`
  (`apps/agent-host/src/main.ts`) - reused by the disposition step.
- [x] Existing `planner` skill (`~/.agents/skills/planner`) - each worker runs it in **implement mode**.

## 1. Architecture

The Worktree Fleet turns a single request - *"make N worktrees that each implement a specific plan and
audit each individually"* - into a durable, parallel, audited run. It is three things layered:

1. a **built-in `worktree-fleet` workflow** on `54` (the orchestration),
2. a **durable, conversationally-entered run** (handoff-owned, resumable), and
3. a **disposition policy** for what happens to the finished trees.

The orchestration itself is **fixed and deterministic** (developer-authored, per `54`'s authoring
model #1); the model re-enters only to parse the request and to do per-tree implementation/audit.
<!-- D-001 -->

### Flow <!-- D-002 -->

```
user request (their session)
  -> parse: N {branch, plan, worktree} specs        (small LLM leaf; "plan" = an existing .plans/NN)
  -> CONFIRM the specs                                (default gate; revisitable)
  -> handoff: spawn a dedicated DURABLE fleet run     (reuse handoff-flow; launching session is freed)
  -> [worktree-fleet workflow on 54]
       phase "implement":  fan out N worker leaves    (isolation:'worktree', write-capable)
                           each runs `planner` implement-mode against its plan, in its own tree
       phase "audit":      after each worker, a verifier leaf reviews that tree's diff   (flat)
  -> aggregate: per-tree report + summary             (durable, re-openable)
  -> disposition: leave branches + report             (default; human merges via /worktree-merge|delete)
```

### Workers = the planner, parallelized <!-- D-003 -->

Each worker leaf is a write-capable, worktree-isolated `54` `agent()` that invokes the **planner skill
in implement mode** against a target **numbered plan** (`.plans/NN`). The fleet is therefore
"parallelize the planner's implement mode across N managed worktrees, then audit each." Plan input is a
list of existing plan refs (resolved against the plan registry), not freeform prompts.

### Flat audit, orchestrator-owned <!-- D-004 -->

After each worker completes, the workflow schedules a separate **auditor/verifier** leaf (the `53`/M2
verifier shape; `code-review`/`simplify`) over that tree's diff. Findings attach to the tree's result.
The worker does **not** spawn its own auditor (v1 is flat, per `54`); the orchestration owns the audit.

### Aggregation + disposition <!-- D-005 -->

The run aggregates a per-tree record - `{ branch, status, diffstat, audit verdict + findings,
conflict-with-base }` - plus a top-line summary, stored in the durable run record and re-openable.
Disposition (default **leave-branches + report**): the fleet stops; the human merges or discards each
tree via the existing `/worktree-merge` / `/worktree-delete`. Recorded alternatives: **PR-per-tree**
(needs a remote; posts audit findings) and **auto-merge clean + passing** (audit becomes a hard gate;
writes to the base branch autonomously).

### Failure, concurrency, durability <!-- D-006 -->

- A worker that fails or stalls is **marked failed**, siblings continue, and it is surfaced in the
  report (logged, never silently dropped); **at most one auto-retry**.
- Concurrency cap is configurable (default ~4-5; "five" fits comfortably); overflow queues on `54`'s
  scheduler.
- The run is a durable background session (`54` lifecycle): it survives the launching browser/tab
  closing and is resumable from `54`'s journal.

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
- **`54`** owns execution (leaves, isolation, journaling, budget, lifecycle).
- **`48`** owns worktree creation/locking; disposition reuses the existing worktree commands.
- **`apps/web`** reuses existing surfaces (session sidebar activity, `/worktree` modal status); **no
  new dashboard**.

### Observability

The run view (reusing `54`'s) shows the implement and audit phases, per-tree status, and the
aggregated report. Per-tree failures and audit verdicts are typed and surfaced. Worker sessions are
inspectable as ordinary sessions; the `/worktree` modal shows live per-tree state.

## 2. Relationship to existing plans

- **Consumes `54`** (engine) - the fleet is its first real workload and proving ground.
- **Realizes the application-half of `53`/M4** (mutating background agents): the merge/reconcile and
  user-approval concerns around write-capable worktree agents live here; the engine-half (isolation +
  lifted read-only) is in `54`.
- Uses the **verifier** that `53` retains (M2) as its auditor leaf.

## 3. Phases

### Phase 1: Spec parse, confirm, handoff entry

**Goal:** a request becomes N approved specs and a dedicated durable run.

**Gate from previous:** `54` can run a built-in workflow in the background.

#### M1: Request -> spec parse

- **Dependencies:** `.plans/54`
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
  2. GREEN: the confirm-spec-first gate + reuse `handoff-flow` to spawn the fleet session/host.
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

- **Dependencies:** M2, `.plans/48`
- **Effort:** L
- **Tasks:**
  1. RED: tests that each spec -> a write-capable worktree leaf running `planner` implement-mode against
     its plan; isolated; non-racing across siblings.
  2. GREEN: the built-in `worktree-fleet` workflow - an "implement" phase fanning out worker leaves
     (`isolation:'worktree'`) on `54`; each invokes the planner.
  3. RED: failure/stall tests - a failed worker is marked failed, siblings continue, `<=1` retry.
  4. GREEN: fail-soft + bounded retry + a structured per-worker result.
  5. REFACTOR: keep worker policy in the workflow, not the engine.

#### M4: Flat audit phase

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: tests that after each worker an auditor leaf (`53`/M2 verifier / `code-review`) reviews that
     tree's diff and attaches a verdict + findings.
  2. GREEN: the "audit" phase (flat; orchestrator-owned).
  3. REFACTOR: reuse the verifier leaf shape from `53`/M2.

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
     conflict-with-base }` + summary, stored in the durable run record and re-openable.
  2. GREEN: aggregation + durable run report (a projection of `54`'s journal).
  3. REFACTOR: keep the report derived, not separately authored.

#### M6: Disposition policy

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: tests for the default **leave-branches + report** (no base-branch writes); plus
     **PR-per-tree** and **auto-merge clean + passing** (audit as a hard gate) options.
  2. GREEN: a disposition executor reusing `/worktree-merge` / `/worktree-delete`; the PR path behind a
     configured remote.
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

- **Tournament mode** - N competing implementations of the *same* thing, ranked. This plan is N
  *independent* plans. Possible future variant.
- **A dedicated multi-run dashboard UI** (split view of N transcripts) - reuse existing surfaces.
- **Model-authored fleet orchestration** - the fleet is a fixed, developer-authored workflow; the
  model only parses the request and does per-tree implementation/audit.
- **Auto-merge as the default** - the default writes nothing to base branches.

## 5. Decisions

Canonical decisions are in `.plans/55-worktree-fleet/plan.db`. Key decisions use `<!-- D-NNN -->`
markers above.
