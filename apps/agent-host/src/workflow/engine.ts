/**
 * The engine run harness (plan 21 M7): it ties the pieces together and runs a workflow's
 * orchestration once. It wires the scheduler (M3) with its progress emitters onto `workflow.*`
 * events, the journal + resume cache (M4), and the budget governor (M5), then exposes them as the
 * `WorkflowApi` "stdlib" (`agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`) a developer-authored
 * built-in workflow is written against. It emits `workflow.started` before and `workflow.completed`
 * after, and runs the body under a fresh ordinal root so resume is deterministic.
 *
 * Responsible for: assembling one run's scheduler + journal + budget into a `WorkflowApi` and running
 * an orchestration body over it with the run lifecycle events.
 * Not for: the detached durable-run spawn/notify (lifecycle.ts), the DSL interpreter (interpreter.ts),
 * or running a single leaf (leaf-host.ts).
 */
import { events, type TrevorEventInput } from "@belay/session";
import { Effect, Either, Ref } from "effect";
import { makeBudget } from "./budget";
import {
  type BatchOptions,
  log as logPrim,
  makeScheduler,
  type PipelineStage,
  parallel as parallelPrim,
  phase as phasePrim,
  pipeline as pipelinePrim,
  type WorkflowEmit,
} from "./concurrency";
import type { WorkflowRunError } from "./errors";
import { type AgentJournal, emptyCache, journaledAgent, type RunCache } from "./journal";
import type { LeafResult } from "./leaf";
import { withRootSlot } from "./ordinal";

/** What a workflow body passes to `api.agent(prompt, opts)`. The engine fingerprints these for resume
 *  and hands them to the leaf runner. */
export interface AgentOpts {
  readonly schema?: unknown;
  readonly model?: unknown;
  readonly isolation?: "worktree";
  readonly tokenBudget?: number;
  readonly stepBudget?: number;
  readonly maxTurns?: number;
}

/** Runs one leaf given its prompt + opts, returning its typed result. The real runner drives
 *  `runAgentLeaf` (leaf-host.ts); tests inject a fake. */
export type LeafRunner = (prompt: string, opts: AgentOpts) => Effect.Effect<LeafResult>;

/** The read-only budget view a workflow body sees: its loop guards, but not `admit`/`record`/`total`
 *  (the engine owns spend accounting, so a body cannot corrupt the shared pool). */
export interface BudgetView {
  readonly remaining: Effect.Effect<number>;
  readonly spent: Effect.Effect<number>;
}

/** The runtime "stdlib" a built-in workflow's orchestration is written against. */
export interface WorkflowApi {
  readonly agent: (prompt: string, opts?: AgentOpts) => Effect.Effect<LeafResult, WorkflowRunError>;
  readonly parallel: (
    thunks: ReadonlyArray<() => Effect.Effect<LeafResult, WorkflowRunError>>,
    options?: BatchOptions,
  ) => Effect.Effect<ReadonlyArray<unknown>, WorkflowRunError>;
  readonly pipeline: <T>(
    items: readonly T[],
    stages: ReadonlyArray<PipelineStage<T>>,
    options?: BatchOptions,
  ) => Effect.Effect<ReadonlyArray<unknown>, WorkflowRunError>;
  readonly phase: (title: string) => Effect.Effect<void>;
  readonly log: (message: string) => Effect.Effect<void>;
  readonly budget: BudgetView;
}

/** A developer-authored built-in workflow: an orchestration over the `WorkflowApi` (the fleet, 46,
 *  is the first). Deterministic control flow; the model re-enters only at `agent()`. */
export type WorkflowBody = (
  api: WorkflowApi,
  args: unknown,
) => Effect.Effect<unknown, WorkflowRunError>;

export type RunResult =
  | { readonly ok: true; readonly leaves: number; readonly value: unknown }
  | { readonly ok: false; readonly leaves: number; readonly error: WorkflowRunError };

export interface EngineDeps {
  readonly runId: string;
  /** Sink for every `workflow.*` event (the journal + progress). */
  readonly emit: (event: TrevorEventInput) => Effect.Effect<void>;
  readonly leafRunner: LeafRunner;
  /** A prior run's cache for resume; omit for a fresh run. */
  readonly cache?: RunCache;
  /** The run's shared token ceiling (null/omitted = unbounded). */
  readonly budgetTotal?: number | null;
  readonly concurrency?: number;
}

/**
 * Run one workflow body to completion over a freshly-assembled `WorkflowApi`, emitting
 * `workflow.started` / `workflow.completed` around it. `agent()` composes the budget spawn-gate,
 * the journal (replay-or-run + `workflow.agent`), and the leaf runner; a budget trip surfaces as a
 * typed `WorkflowRunError`. Never throws - a body failure is captured in the `RunResult`.
 */
export function runWorkflow(
  name: string,
  body: WorkflowBody,
  args: unknown,
  deps: EngineDeps,
): Effect.Effect<RunResult> {
  return Effect.gen(function* () {
    const budget = yield* makeBudget(deps.budgetTotal ?? null);

    const emit: WorkflowEmit = {
      leafFailed: (failure) =>
        deps.emit(
          events.workflowLeafFailed({
            runId: deps.runId,
            kind: failure.kind,
            cause: failure.cause,
            childSessionId: failure.childSessionId,
            ...(failure.detail !== undefined ? { detail: failure.detail } : {}),
          }),
        ),
      log: (message) => deps.emit(events.workflowLog({ runId: deps.runId, message })),
      phase: (title) => deps.emit(events.workflowPhase({ runId: deps.runId, title })),
    };
    const scheduler = yield* makeScheduler(emit, {
      ...(deps.concurrency !== undefined ? { concurrency: deps.concurrency } : {}),
    });
    const journal: AgentJournal = {
      runId: deps.runId,
      cache: deps.cache ?? emptyCache(),
      emit: deps.emit,
      onUsage: (usage) => budget.record(usage),
    };

    // Counts every agent() invocation (sequential or fanned-out) - each leaf goes through here exactly
    // once, so it is the accurate run-wide leaf count (distinct from the scheduler's fan-out backstop).
    const leafCount = yield* Ref.make(0);
    // agent(): journal (replay-or-run) around a budget-gated live leaf. The gate ADMITS a new spawn
    // (a replayed leaf is not gated, so it never admits); the journal's onUsage is the SINGLE usage
    // recording point, for both a live and a replayed leaf - so spend is counted exactly once.
    const agent = (prompt: string, opts: AgentOpts = {}) =>
      Ref.update(leafCount, (n) => n + 1).pipe(
        Effect.flatMap(() =>
          journaledAgent<WorkflowRunError>(journal, prompt, opts, () =>
            budget.admit.pipe(Effect.flatMap(() => deps.leafRunner(prompt, opts))),
          ),
        ),
      );

    const api: WorkflowApi = {
      agent,
      parallel: (thunks, options) => parallelPrim(scheduler, thunks, options),
      pipeline: (items, stages, options) => pipelinePrim(scheduler, items, stages, options),
      phase: (title) => phasePrim(scheduler, title),
      log: (message) => logPrim(scheduler, message),
      budget: { remaining: budget.remaining, spent: budget.spent },
    };

    yield* deps.emit(events.workflowStarted({ runId: deps.runId, workflow: name, args }));
    const outcome = yield* withRootSlot(body(api, args)).pipe(Effect.either);
    const leaves = yield* Ref.get(leafCount);
    yield* deps.emit(
      events.workflowCompleted({ runId: deps.runId, ok: Either.isRight(outcome), leaves }),
    );

    return Either.isRight(outcome)
      ? { ok: true, leaves, value: outcome.right }
      : { ok: false, leaves, error: outcome.left };
  });
}
