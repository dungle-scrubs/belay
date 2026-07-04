# Workflows Runtime - Progress Report

## Summary

- **Current cutoff blockers:** 55
- **Completed current work:** 0
- **Accepted/deferred follow-up:** 7 (Phase 5, gated on 21's M9 sandbox-runner extraction)
- **Superseded/obsolete checklist debt:** 0
- **Current focus:** M1 - Workflow contract & registry

## Completed Current State / Hard Dependencies

- [x] Leaf entry exists: `runDelegatedChild()` (`apps/agent-host/src/agent/delegate.ts`) - the workflow leaf **forks an interruptible entry** from it (D-011), not a thin wrapper over its detached `Effect.runPromise`.
- [x] Journal substrate exists: append-only session log (`apps/session-store/src/log.ts`) + protocol
  (`packages/session/src/protocol.ts`).
- [x] Budget inputs exist: `turn-budget.ts` tiers (a STEP cap, not tokens) + `Usage` on `assistant.completed`.
- [x] Leaf hardening owned here (former plan 12, now dissolved in): schema-forced output + typed **structured** fail-soft + bounded budget over the forked leaf; no separate bounded-child plan.
- [x] HARD DEP `.plans/01-managed-worktree-hardening` is **MERGED** (cwd-lock available); M6 additionally needs net-new **per-leaf cwd routing** through the tool boundary (D-010).
- [x] HARD DEP `.plans/16-tool-script` is **MERGED** (runner shipped); Phase 5 needs 21's own M9 extraction of a shared `sandbox-runner` from it (D-016).
- [x] SUPPORTING `.plans/15-forkable-sessions-lineage` is **MERGED** (durable run/leaf sessions).

## Current Cutoff Blockers

### Phase 1: Engine core + DSL (no sandbox)

**M1 - Workflow contract & registry**
- [ ] RED: `WorkflowSpec` schema validation (phases, agents with `model` as a `ModelRef`,
  sequential/parallel/pipeline, deps); DSL is data, so **statically** reject clocks/RNG and a non-literal header.
- [ ] GREEN: `WorkflowSpec` (Effect Schema) + workflow registry (built-in + saved) + name+args entry.
- [ ] RED: invalid spec / unknown name / bad args tests.
- [ ] GREEN: validation + typed errors.
- [ ] REFACTOR: spec schema separate from execution.

**M2 - `agent()` leaf (forked, interruptible; over `runDelegatedChild`)**
- [ ] RED: `agent(prompt, opts)` spawns one isolated child, returns text; `opts.schema` returns a
  validated object (retry on mismatch); characterization: child sees ONLY the seeded task, never the
  parent transcript (preserve the `runDelegatedChild` isolation invariant, former plan 12).
- [ ] GREEN: extract shared seed/isolation/fold-back; **forked interruptible leaf entry** running the child Effect in the orchestration fiber (not a detached `Effect.runPromise`) + schema-forced result.
- [ ] RED: child-turn failure (`{failed:true}` flag, not a throw), schema-invalid-after-retry, and budget/cancel all surface through ONE **typed** channel with a **structured** cause (+ optional opaque caller `detail`, D-022); fiber interrupt actually halts an in-flight leaf.
- [ ] GREEN: typed structured failure channel (cause + optional caller `detail`, D-022) + interrupt-based cancellation that reaches the child turn.
- [ ] RED: a leaf drives its durable child session (15) across **multiple turns** to a semantic done-signal (per-turn step/context budgets + inter-turn compaction), still **one call ordinal**; single-turn leaf unchanged. (D-017)
- [ ] GREEN: multi-turn leaf loop over the durable child session + **per-leaf token cap / per-turn step budget as `opts`** (`opts.tokenBudget`/`opts.stepBudget`). (D-017, D-020)
- [ ] RED: `opts.model` as a `ModelRef` resolves via `providerForSource`/`buildSourceProvider` (`model-unresolvable` when absent); local-pinned leaf gates on `readiness().warm`, serialises behind the admission gate, surfaces `local-not-ready`.
- [ ] GREEN: `ModelRef` resolution + local-readiness gate.
- [ ] REFACTOR: leaf policy separate from `delegate_*` tool policy.

**M3 - Structured-concurrency primitives**
- [ ] RED: `parallel()` barrier (failures -> `null`), `pipeline()` no-barrier, `phase()`, `log()`.
- [ ] GREEN: implement over `Effect.all` with a runtime concurrency cap.
- [ ] RED: cap enforcement (excess queues) + lifetime-cap backstop.
- [ ] GREEN: bounded scheduler + shared progress emission.
- [ ] RED: every degrade-to-null emits a typed `leaf-failed` event (with **structured** cause, the M2 channel) before returning null - never a bare unrecorded null.
- [ ] GREEN: emit `leaf-failed` on the fail-soft path (owned in M3, not deferred to M8).
- [ ] RED: opt-in strict mode (`onError:'fail'`) rejects the batch on the first leaf failure; default stays fail-soft.
- [ ] GREEN: implement strict mode.
- [ ] REFACTOR: generic, reusable emission.

**Gate 1->2**
- [ ] DSL spec validates, statically rejects non-deterministic constructs, takes `model` as a `ModelRef`.
- [ ] `agent()` isolated, schema-capable, `ModelRef`-resolved (local-readiness-gated), typed-fail-soft, genuinely interrupt-cancellable (halts in-flight), and (heavyweight) runs **multi-turn** to a semantic completion under a per-`agent()` token/step cap.
- [ ] `parallel`/`pipeline`/`phase`/`log` correct under the cap.

### Phase 2: Journaling, resume, budget

**M4 - Run journal + resume**
- [ ] RED: `workflow.*` events appended keyed by `runId`; each `workflow.agent` carries a **deterministic call ordinal keying each `agent()` invocation** (parallel array index / pipeline `(item, stage)`, **each composed with an intra-slot call counter** so a worker + its retry get distinct ordinals) and the leaf's `Usage`. (D-019)
- [ ] GREEN: journaling + `workflow.*` (per-invocation ordinal + `Usage`) protocol additions. (D-019)
- [ ] RED: resume = replay + **per-ordinal** `(prompt, opts)` invalidation (NOT content lookup): identical parallel leaves, a **second `agent()` call within one slot (a retry)**, + out-of-order completion resume correctly; first changed ordinal re-runs; cached leaves restore `Usage` so `budget.remaining()` loops replay identically. (D-019)
- [ ] GREEN: resume engine (ordinal-keyed cache + `Usage` restore).
- [ ] REFACTOR: generic journal projection.

**M5 - WorkflowBudgetGovernor**
- [ ] RED: cumulative `Usage` across leaves; ceiling -> new `agent()` typed error; `remaining()` loop support; **per-leaf token cap AND step budget settable per `agent()` call** (`opts.tokenBudget`/`opts.stepBudget`, distinct from `turn-budget.ts`'s global step cap); budget trip lets in-flight leaves **drain** with overshoot bounded by `(concurrency-cap x per-leaf token cap)`. (D-020)
- [ ] GREEN: governor service (`Context.Tag` + `Layer`) + per-`agent()` token cap (`opts`), reusing `turn-budget.ts` tiers for the per-leaf STEP budget. (D-020)
- [ ] RED: shared-pool accounting.
- [ ] GREEN: shared pool.
- [ ] REFACTOR: budget separate from scheduler.

**Gate 2->3**
- [ ] A run survives restart and resumes with a correct **per-invocation ordinal-keyed** cache-hit prefix (identical parallel leaves, a second `agent()` call within one slot, + out-of-order completion included); cached leaves restore `Usage`.
- [ ] Budget is a typed spawn-gate ceiling with bounded overshoot (per-`agent()` token/step caps; in-flight drain).

### Phase 3: Worktree-isolated write-capable leaves

**M6 - Worktree isolation for leaves** (needs net-new per-leaf cwd routing, D-010/D-023)
- **Process model DECIDED: in-process cwd-threading (D-024)**; out-of-process on `16`'s runner rejected. `46`/M3 unblocked.
- [ ] RED: failing test that two **parallel** worktree leaves write to **distinct** trees - fails today because tools resolve a global `process.cwd()` (`bash.ts`, `read.ts`, `run-shell.ts`, `tools/index.ts`, `WORKSPACE_ROOT`).
- [ ] GREEN: thread a **per-leaf cwd** through the tool boundary (in-process, D-024); **de-globalize `WORKSPACE_ROOT` + the `confine()` guard keyed off it, and convert the `tools/index.ts` module-load `process.cwd()` snapshot to a per-call thunk** - not merely a cwd arg on bash/read/run-shell; + a **guard** lint/test that no tool reads a global cwd; cwd-lock prevents path collision. (D-023, D-024)
- [ ] RED: `opts.isolation:'worktree'` provisions a managed worktree per leaf, lifts read-only for that leaf, and parallel write-capable leaves do not race.
- [ ] GREEN: wire leaf -> `WorktreeManager` + cwd-lock + per-leaf cwd; write-capable in own tree; auto-cleanup; per-leaf worktree result (branch, diffstat, conflict-with-base).
- [ ] REFACTOR: worktree policy in the leaf, not the scheduler.

**Gate 3->4**
- [ ] Parallel write-capable worktree leaves are isolated and non-racing.

### Phase 4: Authoring surfaces + observability

**M7 - Invocation surfaces (built-in + DSL tool)**
- [ ] RED: invoke a built-in/saved workflow by name+args; a `Workflow` tool accepting a DSL spec.
- [ ] GREEN: register the `Workflow` tool + named-workflow path; run as a **detached durable run** (session via 15, launcher not switched/retired) + **run-completion notify distinct from `delegated.to`**. (D-018)
- [ ] RED: loop tests success/failure/cancel/notify; launcher survives and is notified without a switch. (D-018)
- [ ] GREEN: detached durable-run spawn (via 15) + run-completion notify (distinct from `delegated.to`). (D-018)
- [ ] REFACTOR: thin tool surface over the engine.

**M8 - Observability + minimal run view**
- [ ] RED: run/phase/leaf spans + typed failures; a **reusable determinism-characterization harness** for built-ins (run-twice under frozen clock + forbidden RNG -> identical ordinal sequence). (D-021)
- [ ] GREEN: spans + typed failures (cause + optional caller `detail`, D-022) + the built-in determinism harness (D-021) + minimal run-progress surface reusing existing surfaces.
- [ ] REFACTOR: reuse `08-tool-detail-takeover` primitives; keep the determinism harness a shared test util. (D-021)

**Gate 4->5**
- [ ] Built-in and DSL workflows run as a **detached durable run** (launcher survives, notified on completion distinct from `delegated.to`) and fold back.
- [ ] Every built-in passes the **determinism-characterization harness**.
- [ ] Every run/phase/leaf is inspectable.

## Accepted / Deferred Follow-Up

### Phase 5: Model-authored JS (gated on 21's own M9 sandbox-runner extraction)

`.plans/16-tool-script` has **shipped** its out-of-process child runner + OS sandbox (merged). The
remaining prerequisite is 21's own M9 - **extracting** that boundary into a shared `sandbox-runner`
(D-016); this is no longer a wait on `16`. The DSL and built-in authoring paths (Phases 1-4) deliver
dynamic, model-generated, phased workflows without it.

- [ ] M9 RED: contract tests for a generic deny-first out-of-process JS runner with a pluggable bridge.
- [ ] M9 GREEN: extract the child runner + OS sandbox into a shared service; `tool_script` + workflows
  consume it with different bridges.
- [ ] M9 REFACTOR: `16` consumes the shared runner (no behavior change).
- [ ] M10 RED: model-authored JS executed in the sandbox with the workflow-primitive bridge; determinism
  enforced at **runtime by capability-removal** (neutered `Date.now`/`Math.random`/`new Date` throw; FS+network denied), not by static source rejection.
- [ ] M10 GREEN: JS authoring path on the shared `sandbox-runner`.
- [ ] M10 REFACTOR: parity with DSL semantics.
- [ ] Gate 5: JS runs only in the sandbox; DSL and JS produce equivalent run semantics.

## Superseded / Obsolete Checklist Debt

None.
