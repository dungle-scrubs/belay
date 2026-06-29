# Workflows Runtime - Implementation Plan

## 0. Hard Dependencies

- [ ] `.plans/47-bounded-child-takeover` - the workflow `agent()` leaf **is** a bounded child run.
  The runtime reuses `runDelegatedChild()` (`apps/agent-host/src/agent/delegate.ts:91`) for
  isolation, tool clamping, structured fold-back, and lifecycle/failure events. 47 must land its
  bounded-child runtime first.
- [ ] `.plans/10.1-managed-worktree-hardening` - the cwd-path advisory lock. Required before
  worktree-isolated, **write-capable** leaves can run in parallel without clobbering each other.
- [ ] `.plans/50-forkable-sessions-lineage` (supporting) - durable session spawning/lineage that the
  run journal and per-leaf child sessions ride on.
- [ ] `.plans/43-tool-script` - **only** for the later model-authored-JS milestone (Phase 5). Its
  out-of-process child runner + OS sandbox (43's M3/M4) must first be **extracted into a shared
  `sandbox-runner` service**. Not required for v1; the DSL and built-in authoring paths need no sandbox.
- [x] Existing leaf: `runDelegatedChild()` at `apps/agent-host/src/agent/delegate.ts:91` (isolation,
  read-only clamp for background, `delegated.to` fold-back link).
- [x] Existing journal substrate: the append-only session log
  (`apps/session-store/src/log.ts`, `(sessionId, seq)` PK, WAL) and protocol
  (`packages/session/src/protocol.ts`).
- [x] Existing budget inputs: per-turn step budget (`apps/agent-host/src/agent/turn-budget.ts`) and
  `Usage` on `assistant.completed` (`packages/session/src/protocol.ts`).

## 1. Architecture

The Workflows Runtime is a deterministic engine that executes an **orchestration** which spawns
subagents in phases (sequential, parallel, or pipelined) and folds their results back. Its guiding
principle, lifted from Claude Code's Dynamic Workflows (reverse-engineered in
`artifacts/claude-code-workflows-reference.md`), is:

> **Deterministic control flow, stochastic leaves.** The orchestration logic (loops, conditionals,
> fan-out) is deterministic; intelligence is confined to the leaves (`agent()` calls). This is what
> makes runs legible, resumable, and testable. <!-- D-001 -->

It is the **engine** that the worktree-fleet (`.plans/55-worktree-fleet`) and any future multi-agent
orchestration ride on. It is **not** itself a product feature surface; the fleet is its first consumer.

### Effect-native, not a ported scheduler <!-- D-002 -->

The host is Node + Effect (stable v3). The runtime is an **Effect program**, so it does not reimplement
a JS-semaphore scheduler:

- concurrency = `Effect.all` with a bounded `concurrency` option;
- cancellation = **fiber interruption** (no `AbortSignal` threading);
- errors = `Data.TaggedError` in the typed `E` channel;
- dependencies = `Context.Tag` services + `Layer` (the budget governor and emit are services).

### Primitives (the runtime "stdlib") <!-- D-003 -->

| Primitive | Role | Implementation |
|---|---|---|
| `agent(prompt, opts)` | spawn one subagent leaf | calls `runDelegatedChild`; returns text, or a schema-validated object when `opts.schema` is set |
| `parallel(thunks)` | **barrier** fan-out | `Effect.all` over the runtime concurrency gate; a failed thunk degrades to `null` (never rejects) |
| `pipeline(items, ...stages)` | per-item staged flow, **no barrier** | each item runs its own chain; a stage throw drops that item to `null` and skips its rest |
| `phase(title)` | progress grouping | sets the current phase used to bucket subsequent leaves in the run view |
| `log(msg)` | narrator line | emits a progress event |
| `workflow(ref, args)` | nested sub-workflow | **deferred** (see Non-Goals); v1 is flat |

### The `agent()` leaf <!-- D-004 -->

Each `agent()` resolves to one `runDelegatedChild` run: its own isolated child session, tool clamping,
and `delegated.to` fold-back. Two extensions over today's delegation:

- **`opts.isolation: 'worktree'`** provisions a managed worktree (via `.plans/48`'s `WorktreeManager`
  + cwd-lock) for that leaf, and **lifts the D-047/D-048 read-only clamp for that leaf only** - because
  each write-capable leaf works in its **own** tree, parallel writes cannot race. This is the
  engine-half of `53`'s M4 (mutating background agents), and the sanctioned unlock D-047 deferred
  "until managed worktrees, cwd-level locks, and a merge/reconciliation protocol exist."
- **Depth/cap are runtime-owned**, distinct from the interactive `delegate_*` tools'
  `MAX_DELEGATION_DEPTH = 1` and `MAX_BACKGROUND_CHILDREN_PER_SESSION = 4`. v1 is **flat**: leaves are
  bounded children that do not themselves orchestrate.

### Journaling + resume <!-- D-005 -->

A run is keyed by a `runId` and journaled as new `workflow.*` events
(`workflow.started`, `workflow.phase`, `workflow.agent` started/completed, `workflow.completed`)
appended to the existing session log - no new substrate. Resume replays the orchestration and matches
each `agent()` call on `(prompt, opts)`: the longest unchanged prefix returns cached journal results
instantly; the first changed/new call and everything after runs live. Determinism is a hard invariant:
no clocks/RNG inside a workflow spec/script; the `meta`/header is a static literal so it is parseable
without executing the body.

### Budget governor <!-- D-006 -->

A net-new `WorkflowBudgetGovernor` (`Context.Tag` service) tracks cumulative `Usage` across all leaves
in a shared pool. The ceiling is **hard**: once spend reaches the target, further `agent()` calls fail
with a typed error - enabling `while (budget.remaining() > N)` loops. Per-leaf step budgets reuse the
existing `turn-budget.ts` tiers.

### Authoring model <!-- D-007 -->

A workflow can be expressed three ways; **v1 ships the first two** (neither needs a sandbox):

1. **Built-in / saved** - developer-authored TS/Effect modules in a workflow registry, invoked by
   **name + args** (the fleet, `55`, is the first). Trusted, in-process.
2. **Model-authored DSL** - the model emits a **validated structured spec** (phases; agents with
   prompt/schema/model/isolation; sequential/parallel/pipeline; deps) through a `Workflow` tool call;
   the Effect interpreter walks it. No code execution.
3. **Model-authored JS** (Claude-Code parity, **Phase 5, gated on `43`**) - real JS with arbitrary
   control flow, executed in the extracted shared `sandbox-runner`. The biggest, riskiest path; the
   DSL covers fan-out/pipeline/phases without it.

### Lifecycle <!-- D-008 -->

A run is itself a durable background session (its own `runId`); it streams progress events and, on
completion, notifies the launching session (reusing the background-delegation/`task-notification` path).
This durability is what the fleet's resumable run shell (`55`) builds on.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Deterministic control flow | No clocks/RNG in specs; literal header; resume is sound and cheap. |
| Stochastic leaves only | The model re-enters only at `agent()`; orchestration is code. |
| Effect-native | Concurrency/cancellation/errors/DI reuse the host's Effect machinery. |
| Leaf = bounded child | Every `agent()` is a `runDelegatedChild` run; no new spawn machinery. |
| Write only in own worktree | Write-capable leaves require `isolation:'worktree'` + the cwd-lock (`48`). |
| No sandbox in v1 | Built-in + DSL authoring need no code execution; JS is gated on `43`. |
| Hard budget | Spend ceiling throws; cost is bounded by construction. |
| Fail-soft fan-out | `parallel`/`pipeline` degrade a failed item to `null`, never reject the batch. |

### Boundaries

- **`apps/agent-host`** owns the runtime engine, the workflow registry, the `WorkflowBudgetGovernor`,
  the `agent()` leaf wrapper over `runDelegatedChild`, journaling, and the `Workflow` tool surface.
- **`packages/session`** owns the `workflow.*` protocol/read-model additions, grown one event at a time.
- **`apps/session-store`** is the journal (unchanged substrate; new event types only).
- **`apps/web`** owns a minimal run-progress surface, reusing existing session/activity/takeover
  surfaces - **not** a new dashboard (deferred).
- **`sandbox-runner`** (Phase 5) is a shared service extracted from `43`; both `tool_script` and the
  JS authoring path consume it with different bridges.

### Observability

Spans cover the run (`runId`, workflow name, budget), each phase, and each leaf (child session id,
isolation mode, model, duration, budget delta). Failures are typed (spec-invalid, leaf-failed,
budget-exhausted, cancelled, worktree-lock-denied). The minimal run view shows phase/leaf status,
budget counters, and fold-back results; deeper inspection reuses `28-tool-detail-takeover` primitives.

## 2. Relationship to existing plans

- **Subsumes `53`/M3 (Teams)** entirely - bounded fan-out, aggregation, cancellation, and progress
  visibility *are* this engine. The poisoned "teams" noun is dropped (see `53`/§4 `D-003`); the
  orchestration noun is **workflow** (engine) / **fleet** (the `55` application).
- **Subsumes the engine-half of `53`/M4 (Mutating Background Agents)** - worktree-isolated,
  write-capable leaves. The merge/reconcile/approval half is the fleet's (`55`).
- **`53` retains only M2 (Verifier)** - a verifier is a workflow leaf with an adversarial prompt + a
  verdict schema; distinct from the dropped inline self-validation (`53`/§4 `D-033`).
- Resolves `53`/M1's "decide whether these remain one plan or split after discovery": the discovery
  concluded a split into `54` (engine) + `55` (application).

## 3. Phases

### Phase 1: Engine core + DSL (no sandbox)

**Goal:** a workflow spec runs phased sequential/parallel/pipeline leaves over `runDelegatedChild`.

**Gate from previous:** 47's bounded-child runtime is available.

#### M1: Workflow contract & registry

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: tests for `WorkflowSpec` schema (phases; agents with prompt/schema/model/isolation;
     sequential/parallel/pipeline; deps) including rejection of clocks/RNG and a non-literal header.
  2. GREEN: define `WorkflowSpec` (Effect `Schema`), a workflow **registry** (built-in + saved), and a
     name+args invocation entry.
  3. RED: tests for invalid spec, unknown workflow name, bad args.
  4. GREEN: validation + typed errors.
  5. REFACTOR: keep the spec schema separate from execution.

#### M2: `agent()` leaf over `runDelegatedChild`

- **Dependencies:** M1, `.plans/47`
- **Effort:** L
- **Tasks:**
  1. RED: tests that `agent(prompt, opts)` spawns one isolated child and returns text; with
     `opts.schema` returns a validated object (auto-retry on mismatch at the tool-call layer).
  2. GREEN: implement the leaf wrapping `runDelegatedChild`; schema-forced structured result.
  3. RED: tests for leaf failure -> fail-soft `null`; cancellation -> fiber interrupt.
  4. GREEN: fail-soft + interrupt-based cancellation.
  5. REFACTOR: keep leaf policy separate from the interactive `delegate_*` tool policy.

#### M3: Structured-concurrency primitives

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: tests for `parallel()` barrier (failures -> `null`), `pipeline()` no-barrier staged flow,
     `phase()` grouping, `log()` events.
  2. GREEN: implement over `Effect.all` with a runtime concurrency cap.
  3. RED: tests for cap enforcement (excess queues) and a lifetime-cap backstop.
  4. GREEN: bounded scheduler over Effect; shared progress-event emission.
  5. REFACTOR: keep emission generic and reusable.

### Gate 1->2

- [ ] A workflow spec validates and rejects non-deterministic constructs.
- [ ] `agent()` is isolated, schema-capable, fail-soft, and interrupt-cancellable.
- [ ] `parallel`/`pipeline`/`phase`/`log` behave correctly under the concurrency cap.

### Phase 2: Journaling, resume, budget

**Goal:** a run is durable and resumable, and spend is a hard ceiling.

**Gate from previous:** the engine core executes specs.

#### M4: Run journal + resume

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: tests for `workflow.started`/`workflow.phase`/`workflow.agent`/`workflow.completed`
     appended to the session log keyed by `runId`.
  2. GREEN: implement journaling; add `workflow.*` to `packages/session` protocol.
  3. RED: tests for resume = replay + `(prompt, opts)` prefix match -> cached results; first changed
     call re-runs.
  4. GREEN: resume engine.
  5. REFACTOR: keep the journal projection generic.

#### M5: WorkflowBudgetGovernor

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: tests for cumulative `Usage` across leaves; hard ceiling -> `agent()` fails with a typed
     error; `budget.remaining()` loop support.
  2. GREEN: implement the governor service (`Context.Tag` + `Layer`), reusing `turn-budget.ts` tiers
     per leaf.
  3. RED: tests for shared-pool accounting.
  4. GREEN: shared pool.
  5. REFACTOR: keep budget separate from the scheduler.

### Gate 2->3

- [ ] A run survives restart and resumes from the journal with a correct cache-hit prefix.
- [ ] Budget is a hard, typed ceiling.

### Phase 3: Worktree-isolated write-capable leaves

**Goal:** parallel write-capable leaves run safely, each in its own tree.

**Gate from previous:** `.plans/48` cwd-lock is available.

#### M6: Worktree isolation for leaves

- **Dependencies:** M2, `.plans/48`
- **Effort:** L
- **Tasks:**
  1. RED: tests that `opts.isolation:'worktree'` provisions a managed worktree per leaf, lifts the
     read-only clamp for that leaf, and the cwd-lock prevents collision.
  2. GREEN: wire the leaf to `WorktreeManager` + cwd-lock; write-capable in its own tree; auto-cleanup
     if untouched.
  3. RED: tests proving parallel write-capable leaves do not race; merge/reconcile is the caller's job.
  4. GREEN: per-leaf worktree result (branch, diffstat, conflict-with-base).
  5. REFACTOR: keep worktree policy in the leaf, not the scheduler.

### Gate 3->4

- [ ] Parallel write-capable worktree leaves are isolated and non-racing.

### Phase 4: Authoring surfaces + observability

**Goal:** built-in and DSL workflows run on the engine, in the background, with inspection.

**Gate from previous:** the engine, journal, budget, and isolation are reliable.

#### M7: Invocation surfaces (built-in + DSL tool)

- **Dependencies:** M4, M5
- **Effort:** M
- **Tasks:**
  1. RED: tests for invoking a built-in/saved workflow by name+args, and a `Workflow` tool that accepts
     a DSL spec.
  2. GREEN: register the `Workflow` tool (DSL) + named-workflow invoke path; both run in the background
     and notify on completion.
  3. RED: loop tests for success/failure/cancel/notify.
  4. GREEN: background run + `task-notification`-style fold-back.
  5. REFACTOR: keep the tool surface thin over the engine.

#### M8: Observability + minimal run view

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: observability tests for run/phase/leaf spans + typed failures.
  2. GREEN: spans (run id, phase, leaf, isolation, budget) + typed failures; minimal run-progress
     surface reusing existing session/activity surfaces.
  3. REFACTOR: reuse `28-tool-detail-takeover` primitives.

### Gate 4->5

- [ ] Built-in and DSL workflows run in the background and fold back.
- [ ] Every run/phase/leaf is inspectable.

### Phase 5: Model-authored JS (gated on `43`)

**Goal:** the model can author arbitrary-control-flow JS workflows, sandboxed.

**Gate from previous:** DSL authoring is solid and `.plans/43` has shipped its runner.

#### M9: Extract shared `sandbox-runner` from `43`

- **Dependencies:** `.plans/43`
- **Effort:** L
- **Tasks:**
  1. RED: contract tests for a generic out-of-process deny-first JS runner with a pluggable bridge
     (43's M3/M4 generalized).
  2. GREEN: extract the child runner + OS sandbox into a shared service; `tool_script` and workflows
     consume it with different bridges.
  3. REFACTOR: `43` consumes the shared runner (no behavior change).

#### M10: JS workflow authoring

- **Dependencies:** M9
- **Effort:** L
- **Tasks:**
  1. RED: tests for model-authored JS executed in the sandbox with the workflow-primitive bridge
     (`agent`/`parallel`/`pipeline`/`phase`/`log`); determinism guards (no clocks/RNG).
  2. GREEN: the JS authoring path on the shared `sandbox-runner`.
  3. REFACTOR: parity with DSL semantics.

### Gate 5

- [ ] Model-authored JS runs only in the sandbox; arbitrary code never touches the host process.
- [ ] DSL and JS authoring produce equivalent run semantics.

## 4. Non-Goals

- **Multi-user "teams"** - permanently dropped (`53`/§4 `D-003`). "Fleet" is the orchestration noun.
- **Inline self-validation** - dropped (`53`/§4 `D-033`); verification is a leaf, not self-check.
- **A general fleet/dashboard UI** - reuse existing surfaces; a multi-run dashboard is deferred.
- **Executing model-authored JS without the sandbox** - the JS path is gated on `43`, never ad hoc.
- **Replacing the interactive `delegate_*` tools** - they remain for conversational delegation.
- **Nested `workflow()`** - v1 is flat; one level of nesting is a later upgrade.

## 5. Decisions

Canonical decisions are in `.plans/54-workflows-runtime/plan.db`. Key decisions use `<!-- D-NNN -->`
markers above.
