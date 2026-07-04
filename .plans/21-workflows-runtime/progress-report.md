# Workflows Runtime - Progress Report

## Summary

- **Current cutoff blockers:** 50
- **Completed current work:** 0
- **Accepted/deferred follow-up:** 7 (Phase 5, gated on `.plans/16-tool-script`)
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Workflow contract & registry

## Completed Current State / Hard Dependencies

- [x] Leaf entry exists: `runDelegatedChild()` (`apps/agent-host/src/agent/delegate.ts:91`).
- [x] Journal substrate exists: append-only session log (`apps/session-store/src/log.ts`) + protocol
  (`packages/session/src/protocol.ts`).
- [x] Budget inputs exist: `turn-budget.ts` tiers + `Usage` on `assistant.completed`.
- [x] Leaf hardening owned here (former plan 12, now dissolved in): schema-forced output + typed fail-soft + hard budget over the existing `runDelegatedChild` leaf; no separate bounded-child plan.
- [x] HARD DEP identified: `.plans/01-managed-worktree-hardening` (cwd-lock for write-capable isolated leaves).
- [x] SUPPORTING identified: `.plans/15-forkable-sessions-lineage` (durable run/leaf sessions).

## Current Cutoff Blockers

### Phase 1: Engine core + DSL (no sandbox)

**M1 - Workflow contract & registry**
- [ ] RED: `WorkflowSpec` schema validation (phases, agents, sequential/parallel/pipeline, deps);
  reject clocks/RNG and non-literal header.
- [ ] GREEN: `WorkflowSpec` (Effect Schema) + workflow registry (built-in + saved) + name+args entry.
- [ ] RED: invalid spec / unknown name / bad args tests.
- [ ] GREEN: validation + typed errors.
- [ ] REFACTOR: spec schema separate from execution.

**M2 - `agent()` leaf over `runDelegatedChild`**
- [ ] RED: `agent(prompt, opts)` spawns one isolated child, returns text; `opts.schema` returns a
  validated object (retry on mismatch); characterization: child sees ONLY the seeded task, never the
  parent transcript (preserve the `runDelegatedChild` isolation invariant, former plan 12).
- [ ] GREEN: leaf wrapping `runDelegatedChild` + schema-forced result.
- [ ] RED: leaf failure -> fail-soft `null`; cancellation -> fiber interrupt.
- [ ] GREEN: fail-soft + interrupt cancellation.
- [ ] REFACTOR: leaf policy separate from `delegate_*` tool policy.

**M3 - Structured-concurrency primitives**
- [ ] RED: `parallel()` barrier (failures -> `null`), `pipeline()` no-barrier, `phase()`, `log()`.
- [ ] GREEN: implement over `Effect.all` with a runtime concurrency cap.
- [ ] RED: cap enforcement (excess queues) + lifetime-cap backstop.
- [ ] GREEN: bounded scheduler + shared progress emission.
- [ ] RED: every degrade-to-null emits a typed `leaf-failed` event (with cause) before returning null - never a bare unrecorded null.
- [ ] GREEN: emit `leaf-failed` on the fail-soft path (owned in M3, not deferred to M8).
- [ ] RED: opt-in strict mode (`onError:'fail'`) rejects the batch on the first leaf failure; default stays fail-soft.
- [ ] GREEN: implement strict mode.
- [ ] REFACTOR: generic, reusable emission.

**Gate 1->2**
- [ ] Spec validates and rejects non-deterministic constructs.
- [ ] `agent()` isolated, schema-capable, fail-soft, interrupt-cancellable.
- [ ] `parallel`/`pipeline`/`phase`/`log` correct under the cap.

### Phase 2: Journaling, resume, budget

**M4 - Run journal + resume**
- [ ] RED: `workflow.*` events appended keyed by `runId`.
- [ ] GREEN: journaling + `workflow.*` protocol additions.
- [ ] RED: resume = replay + `(prompt, opts)` prefix match -> cached results; first change re-runs.
- [ ] GREEN: resume engine.
- [ ] REFACTOR: generic journal projection.

**M5 - WorkflowBudgetGovernor**
- [ ] RED: cumulative `Usage` across leaves; hard ceiling -> typed error; `remaining()` loop support.
- [ ] GREEN: governor service (`Context.Tag` + `Layer`) reusing `turn-budget.ts` tiers.
- [ ] RED: shared-pool accounting.
- [ ] GREEN: shared pool.
- [ ] REFACTOR: budget separate from scheduler.

**Gate 2->3**
- [ ] A run survives restart and resumes with a correct cache-hit prefix.
- [ ] Budget is a hard, typed ceiling.

### Phase 3: Worktree-isolated write-capable leaves

**M6 - Worktree isolation for leaves**
- [ ] RED: `opts.isolation:'worktree'` provisions a managed worktree per leaf, lifts read-only for that
  leaf, cwd-lock prevents collision.
- [ ] GREEN: wire leaf -> `WorktreeManager` + cwd-lock; write-capable in own tree; auto-cleanup.
- [ ] RED: parallel write-capable leaves do not race.
- [ ] GREEN: per-leaf worktree result (branch, diffstat, conflict-with-base).
- [ ] REFACTOR: worktree policy in the leaf, not the scheduler.

**Gate 3->4**
- [ ] Parallel write-capable worktree leaves are isolated and non-racing.

### Phase 4: Authoring surfaces + observability

**M7 - Invocation surfaces (built-in + DSL tool)**
- [ ] RED: invoke a built-in/saved workflow by name+args; a `Workflow` tool accepting a DSL spec.
- [ ] GREEN: register the `Workflow` tool + named-workflow path; background run + completion notify.
- [ ] RED: loop tests success/failure/cancel/notify.
- [ ] GREEN: background run + `task-notification`-style fold-back.
- [ ] REFACTOR: thin tool surface over the engine.

**M8 - Observability + minimal run view**
- [ ] RED: run/phase/leaf spans + typed failures.
- [ ] GREEN: spans + typed failures + minimal run-progress surface reusing existing surfaces.
- [ ] REFACTOR: reuse `08-tool-detail-takeover` primitives.

**Gate 4->5**
- [ ] Built-in and DSL workflows run in the background and fold back.
- [ ] Every run/phase/leaf is inspectable.

## Accepted / Deferred Follow-Up

### Phase 5: Model-authored JS (gated on `.plans/16-tool-script`)

Deferred until `16` ships its out-of-process child runner + OS sandbox and that boundary is extracted
into a shared `sandbox-runner`. The DSL and built-in authoring paths (Phases 1-4) deliver dynamic,
model-generated, phased workflows without it.

- [ ] M9 RED: contract tests for a generic deny-first out-of-process JS runner with a pluggable bridge.
- [ ] M9 GREEN: extract the child runner + OS sandbox into a shared service; `tool_script` + workflows
  consume it with different bridges.
- [ ] M9 REFACTOR: `16` consumes the shared runner (no behavior change).
- [ ] M10 RED: model-authored JS executed in the sandbox with the workflow-primitive bridge; determinism
  guards.
- [ ] M10 GREEN: JS authoring path on the shared `sandbox-runner`.
- [ ] M10 REFACTOR: parity with DSL semantics.
- [ ] Gate 5: JS runs only in the sandbox; DSL and JS produce equivalent run semantics.

## Superseded / Obsolete Checklist Debt

None.
