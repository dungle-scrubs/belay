# Workflows Runtime - Implementation Plan

## 0. Hard Dependencies

- [x] The workflow `agent()` leaf **reuses** the existing `runDelegatedChild()`
  (`apps/agent-host/src/agent/delegate.ts:91`) subagent leaf: its isolation (explicit-only context,
  no parent-transcript leak), tool clamping, and `delegated.to` fold-back already exist. This plan
  **hardens that leaf** - schema-forced structured output + typed structured fail-soft +
  fiber-interrupt cancellation (M2), and a bounded budget ceiling (M5). Because the existing entry's
  detached `Effect.runPromise` cannot be interrupted or surface a typed cause, M2 **forks an
  interruptible leaf entry** that reuses the extracted isolation/fold-back rather than hardening the
  Promise-returning entry in place (`D-011`). Formerly a separate plan 12 ("bounded-child + takeover"),
  now **dissolved into this plan**: with no model router in V2 there is no host-owned execution packet
  that picks its own model, the leaf isolation + fold-back already exist, the leaf hardening is exactly
  M2/M5 here, and 12's takeover UI had no consumer. <!-- D-007 --> <!-- D-011 -->
- [x] `.plans/01-managed-worktree-hardening` - **merged** (completed, removed from `.plans/`): the
  cwd-path advisory lock exists and is available. It prevents worktree-path **collision** but does
  **not** route a working directory, so M6 additionally needs **per-leaf cwd routing through the tool
  boundary** (net-new; today the tools read a global `process.cwd()`). See M6. <!-- D-010 --> <!-- D-016 -->
- [x] `.plans/15-forkable-sessions-lineage` (supporting) - **merged**: durable session spawning/lineage
  that the run journal and per-leaf child sessions ride on. <!-- D-016 -->
- [x] `.plans/16-tool-script` - **merged**: its out-of-process child runner + OS sandbox have shipped.
  Phase 5 does **not** wait on `16`; its remaining prerequisite is `21`'s own M9 - **extracting** that
  already-shipped runner into a shared `sandbox-runner` service. Not required for v1 (the DSL and
  built-in authoring paths need no sandbox). <!-- D-016 -->
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

It is the **engine** that the worktree-fleet (`.plans/46-worktree-fleet`) and any future multi-agent
orchestration ride on. It is **not** itself a product feature surface; the fleet is its first consumer.

### Effect-native, not a ported scheduler

The host is Node + Effect (stable v3). The runtime is an **Effect program**, so it does not reimplement
a JS-semaphore scheduler:

- concurrency = `Effect.all` with a bounded `concurrency` option;
- cancellation = **fiber interruption** (no `AbortSignal` threading);
- errors = `Data.TaggedError` in the typed `E` channel;
- dependencies = `Context.Tag` services + `Layer` (the budget governor and emit are services).

### Primitives (the runtime "stdlib")

| Primitive | Role | Implementation |
|---|---|---|
| `agent(prompt, opts)` | spawn one subagent leaf | an **interruptible** leaf entry (forked from `runDelegatedChild`) that runs the child turn's Effect in the orchestration fiber; **may run multi-turn** to a semantic completion for heavyweight work (D-017); returns text, or a schema-validated object when `opts.schema` is set; `opts.model` is a `ModelRef` (source+model); `opts.tokenBudget`/`opts.stepBudget` size the per-leaf caps. <!-- D-011 --> <!-- D-014 --> <!-- D-017 --> <!-- D-020 --> |
| `parallel(thunks)` | **barrier** fan-out | `Effect.all` over the runtime concurrency gate; a leaf's **typed failure** (child-turn-failed / schema-invalid / budget) degrades to `null` **after emitting a typed `leaf-failed` event carrying the structured cause** (never rejects; `opts.onError:'fail'` rejects the batch instead). <!-- D-012 --> |
| `pipeline(items, ...stages)` | per-item staged flow, **no barrier** | each item runs its own chain; a stage's typed failure drops that item to `null` (**emitting `leaf-failed`**) and skips its rest (`opts.onError:'fail'` rejects instead). <!-- D-012 --> |
| `phase(title)` | progress grouping | sets the current phase used to bucket subsequent leaves in the run view |
| `log(msg)` | narrator line | emits a progress event |
| `workflow(ref, args)` | nested sub-workflow | **deferred** (see Non-Goals); v1 is flat |

### The `agent()` leaf <!-- D-002 -->

Each `agent()` runs one isolated child turn - its own child session, tool clamping, and `delegated.to`
fold-back - reusing the isolation/seed/fold-back logic of `runDelegatedChild` (`delegate.ts`). It is
**not** a thin wrapper over the *existing* `runDelegatedChild`: that entry returns a never-throwing
Promise from a **detached** `Effect.runPromise` (`delegate.ts:145`), which can be neither interrupted
nor made to surface a typed cause. The leaf is instead a **forked, interruptible entry** that runs the
child turn's Effect **inside the orchestration fiber tree** and returns a typed result/failure; the
shared seed/isolation/fold-back is extracted so both entries reuse it. <!-- D-011 -->

Extensions over today's delegation:

- **Multi-turn worker leaf.** For heavyweight work (e.g. `46`'s whole-plan planner worker) a leaf may
  drive its durable child session (`15`) across **multiple turns** to a semantic completion, not a
  single `publishTurn`: one turn is hard-bounded (`EMERGENCY_MAX_STEPS = 256`, the sole finite
  step-axis stop, plus forced synthesis at `contextBudgetFraction = 0.8` of the window), so a
  whole-plan run needs many turns with per-turn budgets + inter-turn compaction. It stays **flat**
  (`D-005`: no sub-delegation) and is still **one call ordinal** (`D-019`); an incomplete multi-turn
  leaf re-runs from its first turn (leaf-level resume granularity). <!-- D-017 -->
- **Interruptible + typed failure.** Because the child Effect composes into the parent fiber, fiber
  interruption (cancel, strict-mode reject, hard budget cancel) actually halts an in-flight leaf and
  stops its spend. The leaf exposes ONE typed failure channel unifying child-turn-failure (today a
  `{failed:true}` **flag**, not a throw), schema-invalid-after-retry, and budget-exhausted/cancelled;
  `parallel`/`pipeline` observe this typed failure (never an exception), and every `leaf-failed` event
  carries a **structured** cause (child failure taxonomy + child session id) - optionally plus an
  **opaque caller-supplied `detail`** (e.g. the worker's last milestone/gate) so a fail-soft-null leaf
  is diagnosable from the journal - not a folded error string. <!-- D-012 --> <!-- D-022 -->
- **`opts.model` is a `ModelRef` (source + model id)**, not a bare string - it resolves through
  `providerForSource` / `buildSourceProvider` (`catalog.ts`) and fails with a typed
  `model-unresolvable` when absent from the catalog. A leaf pinned to a **local** model gates on
  `provider.readiness().warm` first and **serialises behind the existing background admission gate**
  (the local-runtime queue) rather than thrashing the single loaded LM Studio model; a not-warm local
  pin surfaces a typed `local-not-ready` failure. <!-- D-014 -->
- **Per-leaf budget is `opts`.** `opts.tokenBudget` (aggregate token cap over all the leaf's turns)
  and `opts.stepBudget` (per-turn step budget over `turn-budget.ts` tiers) are set **per `agent()`
  call** with runtime defaults, so a heavyweight leaf sizes up without weakening the global
  no-single-leaf-overshoots bound for lightweight leaves elsewhere. <!-- D-020 -->
- **`opts.isolation: 'worktree'`** provisions a managed worktree (via `01`'s `WorktreeManager` +
  cwd-lock) for that leaf and **lifts the read-only clamp** (delegation `D-047`/`D-048`) for that leaf
  only. Safe **parallel** writes additionally require **per-leaf cwd routing through the tool boundary**:
  the tools read a global `process.cwd()` today, and `01`'s cwd-lock prevents path collision but does
  not route a working directory - see M6. This is the engine-half of `45`'s M4 (mutating background
  agents), and the sanctioned unlock delegation-`D-047` deferred "until managed worktrees, cwd-level
  locks, and a merge/reconciliation protocol exist." <!-- D-010 -->
- **Depth/cap are runtime-owned**, distinct from the interactive `delegate_*` tools'
  `MAX_DELEGATION_DEPTH = 1` and `MAX_BACKGROUND_CHILDREN_PER_SESSION = 4`. v1 is **flat**: leaves are
  isolated delegated children that do not themselves orchestrate. <!-- D-005 -->

### Journaling + resume

A run is keyed by a `runId` and journaled as new `workflow.*` events
(`workflow.started`, `workflow.phase`, `workflow.agent` started/completed, `workflow.completed`)
appended to the existing session log - no new substrate. Each `workflow.agent` event carries a
**deterministic call ordinal** keying **each `agent()` invocation** in replay order: a `parallel`
batch's thunk takes its array index and a `pipeline` slot takes `(item-index, stage-index)`, **each
composed with an intra-slot program-order counter** so multiple `agent()` calls in one thunk/slot - e.g.
a worker leaf plus its conditional retry (`46/D-016`) - get **distinct** ordinals rather than colliding
on the slot key. The journal keys a leaf's result by that **ordinal, not by content**, so
emission-ordered / out-of-order appends still reconstruct call -> result. <!-- D-019 --> Resume replays the orchestration and, at each ordinal, uses `(prompt, opts)`
only as an **invalidation check**: the first ordinal whose `(prompt, opts)` differs - and everything
after it - runs live; the unchanged prefix returns cached results. Content matching alone is discarded:
it cannot disambiguate identical parallel leaves (e.g. N identical refuters, loop-until-dry) and is
unsound under out-of-order completion. Cached leaves also **restore their journaled `Usage`** into the
budget governor, so budget-dependent control flow replays deterministically. <!-- D-009 -->

Determinism is necessary but **not sufficient on its own**: no clocks/RNG inside a workflow spec/script
and a static-literal `meta`/header (parseable without executing the body) are **paired with** the
ordinal journal above and Usage replay to make resume sound. Enforcement is per authoring path (see
Authoring model). <!-- D-015 -->

### Budget governor

A net-new `WorkflowBudgetGovernor` (`Context.Tag` service) tracks cumulative `Usage` across all leaves
in a shared pool. The ceiling gates **new `agent()` spawns**: once spend reaches the target, further
`agent()` calls fail with a typed error - enabling `while (budget.remaining() > N)` loops. It bounds
*starting* work, not a mid-flight kill: a budget trip lets already-running leaves **drain** (only an
explicit hard cancel interrupts them, per the interruptible leaf). Because `turn-budget.ts` caps tool
**steps**, not tokens, each leaf also gets a **per-leaf token cap** - settable **per `agent()` call**
via `opts.tokenBudget`/`opts.stepBudget` with runtime defaults (`D-020`) - so no single leaf overshoots
unboundedly and a heavyweight leaf can size up without weakening the bound for lightweight leaves;
worst-case overshoot is bounded by `(concurrency-cap x per-leaf token cap)`. Per-leaf **step** budgets
reuse the existing `turn-budget.ts` tiers (a distinct axis from the token pool); for a **multi-turn
leaf** (`D-017`) the token cap bounds aggregate spend across turns while the step budget bounds each
turn. On resume, cached leaves restore their journaled `Usage` (see Journaling + resume) so
budget-dependent loops replay deterministically. <!-- D-013 --> <!-- D-020 -->

### Authoring model <!-- D-003 -->

A workflow can be expressed three ways; **v1 ships the first two** (neither needs a sandbox):

1. **Built-in / saved** - developer-authored TS/Effect modules in a workflow registry, invoked by
   **name + args** (the fleet, `46`, is the first). Trusted, in-process; determinism is by convention
   (no clock ban is statically enforced) **but every built-in must pass a reusable
   determinism-characterization harness** - run twice under a frozen clock + forbidden RNG, asserting
   an identical ordinal/event sequence - so an accidental `Date.now()`/`Math.random()` in a built-in
   cannot silently break resume. <!-- D-021 -->
2. **Model-authored DSL** - the model emits a **validated structured spec** (phases; agents with
   prompt/schema/model/isolation; sequential/parallel/pipeline; deps) through a `Workflow` tool call;
   the Effect interpreter walks it. No code execution. Determinism is **statically checked** here: the
   spec is data, so clock/RNG references and a non-literal header are rejected outright.
3. **Model-authored JS** (Claude-Code parity, **Phase 5, gated on `21`'s own M9 sandbox-runner
   extraction from the already-shipped `16`**) - real JS with arbitrary control flow, executed in the
   extracted shared `sandbox-runner`. Determinism here **cannot be statically proven**; it is enforced
   at **runtime by capability-removal** (neutered `Date.now`/`Math.random`/argless `new Date` that
   throw; denied filesystem+network; curated globals), not by rejecting the source. The biggest,
   riskiest path; the DSL covers fan-out/pipeline/phases without it. <!-- D-015 -->

### Lifecycle <!-- D-018 -->

A run is itself a **durable background session** (its own `runId`), spawned via `15`'s forkable-session
spawning - **not** the read-only, cap-4 `delegate_background` path (single-turn, folds back through the
generic `delegated.to`), and **not** `handoff-flow`'s switch+retire. The launching session is **neither
switched nor retired**: it survives, streams progress events, and on `workflow.completed` receives a
**run-completion notification distinct from `delegated.to`**. The run is write-capable (its leaves gate
worktree writes via M6) and resumable from the journal. Owning this **detached spawn+notify primitive**
here (M7) is what the fleet's resumable run shell (`46`, `46/D-022`) rides directly - the fleet no
longer builds its own from `handoff-flow`. <!-- D-018 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Deterministic control flow | No clocks/RNG in specs + literal header, **paired with** a per-invocation ordinal-keyed journal (`D-019`) and Usage replay; **built-ins must pass a determinism harness** (`D-021`). <!-- D-009 --> <!-- D-019 --> <!-- D-021 --> |
| Stochastic leaves only | The model re-enters only at `agent()`; orchestration is code. |
| Effect-native | Concurrency = `Effect.all`; **cancellation = fiber interrupt over an interruptible leaf** (child Effect runs in the parent fiber, not a detached `runPromise`); errors/DI reuse the host's Effect machinery. <!-- D-011 --> |
| Leaf = isolated delegated child | Every `agent()` is a **forked, interruptible** entry reusing `runDelegatedChild`'s isolation/fold-back, hardened here (schema/budget/typed-structured-failure); not a wrapper over the detached-Promise entry. <!-- D-011 --> <!-- D-012 --> |
| Write only in own worktree | Write-capable leaves require `isolation:'worktree'` + `01`'s cwd-lock **and per-leaf cwd routing through the tool boundary** (M6). <!-- D-010 --> |
| No sandbox in v1 | Built-in + DSL authoring need no code execution; JS is gated on `21`'s M9 extraction of a shared runner from the shipped `16`. <!-- D-016 --> |
| Durable detached run | A run is a durable session (via `15`) the launcher survives; completion notifies distinct from `delegated.to`; not switch+retire, not read-only `delegate_background`. <!-- D-018 --> |
| Bounded budget | Spend ceiling throws on new spawns; in-flight leaves drain; per-leaf token/step caps are `opts` (`D-020`) bounding worst-case overshoot to `(concurrency-cap x per-leaf tokens)`. <!-- D-013 --> <!-- D-020 --> |
| Fail-soft fan-out (default) | `parallel`/`pipeline` degrade a failed item to `null` **and always emit a typed `leaf-failed` event** (a null VALUE to the orchestration, never a silent failure); opt-in `onError:'fail'` rejects the batch instead. <!-- D-008 --> |

### Boundaries

- **`apps/agent-host`** owns the runtime engine, the workflow registry, the `WorkflowBudgetGovernor`,
  the `agent()` leaf (a forked, interruptible entry reusing `runDelegatedChild`'s isolation/fold-back),
  the **durable-run lifecycle** (detached spawn via `15` + run-completion notify, `D-018`), journaling,
  and the `Workflow` tool surface.
- **`packages/session`** owns the `workflow.*` protocol/read-model additions, grown one event at a time.
- **`apps/session-store`** is the journal (unchanged substrate; new event types only).
- **`apps/web`** owns a minimal run-progress surface, reusing existing session/activity/takeover
  surfaces - **not** a new dashboard (deferred).
- **`sandbox-runner`** (Phase 5) is a shared service extracted from `16`; both `tool_script` and the
  JS authoring path consume it with different bridges.

### Observability

Spans cover the run (`runId`, workflow name, budget), each phase, and each leaf (child session id,
isolation mode, model, duration, budget delta). Failures are typed (spec-invalid, leaf-failed,
budget-exhausted, cancelled, worktree-lock-denied, model-unresolvable, local-not-ready). The
`leaf-failed` event is emitted by the M3 fail-soft path itself (D-008), so a degraded-to-null leaf is
always journaled - M8 adds spans/run-view over these events, it does not gate whether a failure is
recorded. Each `leaf-failed` carries a **structured** cause (child failure taxonomy + child session id,
plus an **optional opaque caller `detail`**, per the leaf's typed failure channel), so a failure is
diagnosable from the span without first opening the child transcript; deeper inspection still reuses
`08-tool-detail-takeover` primitives. The minimal run view shows phase/leaf status (bucketed by call
ordinal), budget counters, and fold-back results. Built-in workflows additionally ship a
**determinism-characterization test** (run-twice under a frozen clock + forbidden RNG -> identical
ordinal sequence), the trust boundary for the by-convention authoring path. <!-- D-012 --> <!-- D-021 --> <!-- D-022 -->

## 2. Relationship to existing plans

- <!-- D-004 --> **Subsumes `45`/M3 (Teams)** entirely - bounded fan-out, aggregation, cancellation, and progress
  visibility *are* this engine. <!-- D-006 --> The poisoned "teams" noun is dropped (see `45`/§4 `D-003`); the
  orchestration noun is **workflow** (engine) / **fleet** (the `46` application).
- **Subsumes the engine-half of `45`/M4 (Mutating Background Agents)** - worktree-isolated,
  write-capable leaves. The merge/reconcile/approval half is the fleet's (`46`).
- **`45` retains only M2 (Verifier)** - a verifier is a workflow leaf with an adversarial prompt + a
  verdict schema; distinct from the dropped inline self-validation (`45`/§4 `D-033`).
- Resolves `45`/M1's "decide whether these remain one plan or split after discovery": the discovery
  concluded a split into `21` (engine) + `46` (application).

## 3. Phases

### Phase 1: Engine core + DSL (no sandbox)

**Goal:** a workflow spec runs phased sequential/parallel/pipeline leaves over `runDelegatedChild`.

**Gate from previous:** the delegated-child leaf (`runDelegatedChild`) exists; this plan hardens it
in M2/M5 (no separate bounded-child plan).

#### M1: Workflow contract & registry

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: tests for `WorkflowSpec` schema (phases; agents with prompt/schema/`model` as a `ModelRef`/
     isolation; sequential/parallel/pipeline; deps). The DSL is data, so determinism is **statically
     checked**: reject clock/RNG references and a non-literal header. <!-- D-014 --> <!-- D-015 -->
  2. GREEN: define `WorkflowSpec` (Effect `Schema`), a workflow **registry** (built-in + saved), and a
     name+args invocation entry.
  3. RED: tests for invalid spec, unknown workflow name, bad args.
  4. GREEN: validation + typed errors.
  5. REFACTOR: keep the spec schema separate from execution.

#### M2: `agent()` leaf over `runDelegatedChild`

- **Dependencies:** M1
- **Effort:** L
- **Tasks:**
  1. RED: tests that `agent(prompt, opts)` spawns one isolated child and returns text; with
     `opts.schema` returns a validated object (auto-retry on mismatch at the tool-call layer); plus a
     characterization test that the child sees ONLY the seeded task, never the parent transcript
     (preserving the `runDelegatedChild` isolation invariant formerly emphasized by plan 12). <!-- D-007 -->
  2. GREEN: extract the shared seed/isolation/fold-back from `runDelegatedChild`; implement a **forked,
     interruptible leaf entry** that runs the child turn's Effect **in the orchestration fiber** (not a
     detached `Effect.runPromise`); schema-forced structured result. <!-- D-011 -->
  3. RED: tests that a child-turn failure (the `{failed:true}` flag, not a throw), a
     schema-invalid-after-retry, and a budget/cancel each surface through ONE **typed** failure channel
     carrying a **structured** cause; and that fiber interruption actually halts an in-flight leaf
     (stops its spend), not merely detaches it. <!-- D-011 --> <!-- D-012 -->
  4. GREEN: the typed failure channel (structured cause + optional opaque caller `detail`, `D-022`) +
     interrupt-based cancellation that reaches the child turn. <!-- D-022 -->
  5. RED: a leaf drives its durable child session (`15`) across **multiple turns** to a semantic
     done-signal, with per-turn step/context budgets + inter-turn compaction, and is still **one call
     ordinal**; a single-turn leaf is unchanged. <!-- D-017 -->
  6. GREEN: the multi-turn leaf loop (turn-by-turn over the durable child session) with a **per-leaf
     token cap + per-turn step budget as `opts`** (`opts.tokenBudget`/`opts.stepBudget`). <!-- D-017 --> <!-- D-020 -->
  7. RED: `opts.model` as a `ModelRef` resolves via `providerForSource`/`buildSourceProvider`, failing
     `model-unresolvable` when absent; a **local**-pinned leaf gates on `readiness().warm`, serialises
     behind the background admission gate, and surfaces `local-not-ready` when not warm. <!-- D-014 -->
  8. GREEN: `ModelRef` resolution + local-readiness gate.
  9. REFACTOR: keep leaf policy separate from the interactive `delegate_*` tool policy.

#### M3: Structured-concurrency primitives

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: tests for `parallel()` barrier (failures -> `null`), `pipeline()` no-barrier staged flow,
     `phase()` grouping, `log()` events.
  2. GREEN: implement over `Effect.all` with a runtime concurrency cap.
  3. RED: tests for cap enforcement (excess queues) and a lifetime-cap backstop.
  4. GREEN: bounded scheduler over Effect; shared progress-event emission.
  5. RED: test that EVERY degrade-to-null (`parallel` and `pipeline`) emits a typed `leaf-failed`
     event carrying the child's **structured** cause (the M2 typed failure channel) BEFORE returning
     null - a failed leaf is never a bare, unrecorded null. <!-- D-008 --> <!-- D-012 -->
  6. GREEN: emit the typed `leaf-failed` event on the fail-soft path itself (owned in M3, not
     deferred to M8's observability - M8 only adds spans/run-view over these already-emitted events).
  7. RED: test the opt-in strict mode - `parallel`/`pipeline` with `opts.onError:'fail'` reject the
     batch with a typed error on the first leaf failure (default stays fail-soft `null`).
  8. GREEN: implement the strict-mode option.
  9. REFACTOR: keep emission generic and reusable.

### Gate 1->2

- [ ] A DSL spec validates, statically rejects non-deterministic constructs, and takes `model` as a `ModelRef`.
- [ ] `agent()` is isolated, schema-capable, `ModelRef`-resolved (local-readiness-gated), typed-fail-soft, genuinely interrupt-cancellable (interruption halts an in-flight leaf), and (for heavyweight work) runs **multi-turn** to a semantic completion under a per-`agent()` token/step cap.
- [ ] `parallel`/`pipeline`/`phase`/`log` behave correctly under the concurrency cap.

### Phase 2: Journaling, resume, budget

**Goal:** a run is durable and resumable, and spend is bounded by a typed spawn-gate ceiling.

**Gate from previous:** the engine core executes specs.

#### M4: Run journal + resume

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: tests that `workflow.started`/`workflow.phase`/`workflow.agent`/`workflow.completed` append
     to the session log keyed by `runId`, and that each `workflow.agent` carries a **deterministic call
     ordinal keying each `agent()` invocation** (parallel array index / pipeline `(item, stage)`, **each
     composed with an intra-slot call counter** so a worker + its retry get distinct ordinals) and the
     leaf's `Usage`. <!-- D-009 --> <!-- D-019 -->
  2. GREEN: implement journaling; add `workflow.*` (with the per-invocation ordinal + `Usage`) to
     `packages/session` protocol. <!-- D-019 -->
  3. RED: resume = replay + **per-ordinal** `(prompt, opts)` invalidation (NOT a content lookup): two
     **identical**-`(prompt,opts)` parallel leaves, a **second `agent()` call within one slot (a retry)**,
     and an out-of-order completion all resume correctly; the first changed ordinal and everything after
     re-runs; cached leaves restore `Usage` so a `budget.remaining()` loop replays the same iteration
     count. <!-- D-009 --> <!-- D-013 --> <!-- D-019 -->
  4. GREEN: resume engine (ordinal-keyed cache + `Usage` restore).
  5. REFACTOR: keep the journal projection generic.

#### M5: WorkflowBudgetGovernor

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: tests for cumulative `Usage` across leaves; ceiling -> a **new** `agent()` fails with a typed
     error; `budget.remaining()` loop support; a **per-leaf token cap AND step budget settable per
     `agent()` call** (`opts.tokenBudget`/`opts.stepBudget`, distinct from `turn-budget.ts`'s global
     step cap) so a heavyweight leaf sizes up while lightweight leaves keep the bound; a budget trip lets
     in-flight leaves **drain** with overshoot bounded by `(concurrency-cap x per-leaf token cap)`. <!-- D-013 --> <!-- D-020 -->
  2. GREEN: implement the governor service (`Context.Tag` + `Layer`) + the per-`agent()` token cap
     (`opts`), reusing `turn-budget.ts` tiers for the per-leaf **step** budget. <!-- D-020 -->
  3. RED: tests for shared-pool accounting.
  4. GREEN: shared pool.
  5. REFACTOR: keep budget separate from the scheduler.

### Gate 2->3

- [ ] A run survives restart and resumes with a correct **per-invocation ordinal-keyed** cache-hit prefix (identical parallel leaves, a second `agent()` call within one slot, and out-of-order completion included); cached leaves restore `Usage`.
- [ ] Budget is a typed spawn-gate ceiling with bounded overshoot (per-`agent()` token/step caps; in-flight leaves drain).

### Phase 3: Worktree-isolated write-capable leaves

**Goal:** parallel write-capable leaves run safely, each in its own tree.

**Gate from previous:** `01`'s cwd-lock is **merged/available**; the remaining M6 prerequisite is
**per-leaf cwd routing through the tool boundary** (net-new, M6 task 1).

#### M6: Worktree isolation for leaves

- **Dependencies:** M2; `.plans/01-managed-worktree-hardening` (**merged** - cwd-lock available); **and
  per-leaf cwd routing through the tool boundary** (net-new; task 1 below). <!-- D-010 -->
- **Effort:** L (larger if in-process cwd-threading is chosen over out-of-process leaves - owner
  decision, D-010/D-023)
- **Owner decision (confirm before `46`/M3):** in-process cwd-threading (recommended default) vs
  out-of-process leaves on `16`'s runner; it sets M6's effort and may pull M9's sandbox-runner forward. <!-- D-023 -->
- **Tasks:**
  1. RED: a failing test that two **parallel** worktree leaves write to **distinct** trees - which
     fails today because the tools resolve a global `process.cwd()` (`bash.ts`, `read.ts`,
     `run-shell.ts`, `tools/index.ts`, `WORKSPACE_ROOT`). This pins the per-leaf cwd requirement. <!-- D-010 -->
  2. GREEN: thread a **per-leaf cwd** through the tool execution boundary (recommended default) so each
     leaf resolves paths/`spawn` against its own worktree. This **de-globalizes** the module-level
     `WORKSPACE_ROOT` (`boot/paths.ts`) **and the `confine()` path-guard that keys off it** (a
     write-safety concern - a leaf could confine against the wrong root), and converts the
     `tools/index.ts` module-**load** `process.cwd()` snapshot to a **per-call thunk** (the tool-script
     bridge already models one) - not merely a cwd arg on bash/read/run-shell. `01`'s cwd-lock prevents
     path collision. Fallback if in-process threading proves infeasible: run worktree leaves
     **out-of-process** on `16`'s shipped runner. <!-- D-010 --> <!-- D-023 -->
  3. RED: tests that `opts.isolation:'worktree'` provisions a managed worktree per leaf, lifts the
     read-only clamp for that leaf, and parallel write-capable leaves **do not race**; merge/reconcile
     is the caller's job.
  4. GREEN: wire the leaf to `WorktreeManager` + cwd-lock + per-leaf cwd; write-capable in its own
     tree; auto-cleanup if untouched; per-leaf worktree result (branch, diffstat, conflict-with-base).
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
  2. GREEN: register the `Workflow` tool (DSL) + named-workflow invoke path; both run as a **detached
     durable run** - a session spawned via `15`, launcher **not** switched/retired - emitting a
     **run-completion notification distinct from `delegated.to`**. <!-- D-018 -->
  3. RED: loop tests for success/failure/cancel/notify; the launcher survives and is notified without a
     switch. <!-- D-018 -->
  4. GREEN: the detached durable-run spawn (via `15`) + run-completion notify (distinct from
     `delegated.to`). <!-- D-018 -->
  5. REFACTOR: keep the tool surface thin over the engine.

#### M8: Observability + minimal run view

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: observability tests for run/phase/leaf spans + typed failures; a **reusable
     determinism-characterization harness** for built-in workflows (run-twice under a frozen clock +
     forbidden RNG -> identical ordinal sequence). <!-- D-021 -->
  2. GREEN: spans (run id, phase, leaf, isolation, budget) + typed failures (structured cause + optional
     caller `detail`, `D-022`) + the built-in determinism harness (`D-021`); minimal run-progress
     surface reusing existing session/activity surfaces. <!-- D-021 --> <!-- D-022 -->
  3. REFACTOR: reuse `08-tool-detail-takeover` primitives; keep the determinism harness a shared test
     util any built-in consumes. <!-- D-021 -->

### Gate 4->5

- [ ] Built-in and DSL workflows run as a **detached durable run** (launcher survives, notified on completion distinct from `delegated.to`) and fold back.
- [ ] Every built-in passes the **determinism-characterization harness**.
- [ ] Every run/phase/leaf is inspectable.

### Phase 5: Model-authored JS (gated on `21`'s M9 sandbox-runner extraction)

**Goal:** the model can author arbitrary-control-flow JS workflows, sandboxed.

**Gate from previous:** DSL authoring is solid and `16` has shipped its runner (merged); the remaining
prerequisite is `21`'s own M9 extraction of a shared `sandbox-runner` from it. <!-- D-016 -->

#### M9: Extract shared `sandbox-runner` from `16`

- **Dependencies:** `.plans/16-tool-script`
- **Effort:** L
- **Tasks:**
  1. RED: contract tests for a generic out-of-process deny-first JS runner with a pluggable bridge
     (16's M3/M4 generalized).
  2. GREEN: extract the child runner + OS sandbox into a shared service; `tool_script` and workflows
     consume it with different bridges.
  3. REFACTOR: `16` consumes the shared runner (no behavior change).

#### M10: JS workflow authoring

- **Dependencies:** M9
- **Effort:** L
- **Tasks:**
  1. RED: tests for model-authored JS executed in the sandbox with the workflow-primitive bridge
     (`agent`/`parallel`/`pipeline`/`phase`/`log`); determinism enforced at **runtime by
     capability-removal** (neutered `Date.now`/`Math.random`/argless `new Date` throw; FS+network
     denied), NOT by statically rejecting the source. <!-- D-015 -->
  2. GREEN: the JS authoring path on the shared `sandbox-runner`.
  3. REFACTOR: parity with DSL semantics.

### Gate 5

- [ ] Model-authored JS runs only in the sandbox; arbitrary code never touches the host process.
- [ ] DSL and JS authoring produce equivalent run semantics.

## 4. Non-Goals

- **Multi-user "teams"** - permanently dropped (`45`/§4 `D-003`). "Fleet" is the orchestration noun.
- **Inline self-validation** - dropped (`45`/§4 `D-033`); verification is a leaf, not self-check.
- **A general fleet/dashboard UI** - reuse existing surfaces; a multi-run dashboard is deferred.
- **Executing model-authored JS without the sandbox** - the JS path is gated on the shared
  `sandbox-runner` (M9, extracted from the shipped `16`), never ad hoc.
- **Replacing the interactive `delegate_*` tools** - they remain for conversational delegation.
- **Nested `workflow()`** - v1 is flat; one level of nesting is a later upgrade.

## 5. Decisions

Canonical decisions are in `.plans/21-workflows-runtime/plan.db` (D-001..D-023). Key decisions use
`<!-- D-NNN -->` markers above; a bare `D-NNN` marker denotes **this** plan's ledger. References to
another plan's ledger are namespaced (e.g. `delegation/D-047`, `45/§4 D-033`, `46/D-016`) so they are
never mistaken for this plan's decisions.

D-017..D-023 close the `46`-consumer design audit: the multi-turn worker leaf (D-017), the
21-owned detached durable-run lifecycle (D-018), the per-invocation call ordinal (D-019), per-`agent()`
budget caps (D-020), the built-in determinism harness (D-021), the optional caller `detail` on
`leaf-failed` (D-022), and the widened M6 cwd scope + gated process-model choice (D-023).
