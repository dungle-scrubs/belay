/**
 * The `WorkflowBudgetGovernor` (plan 21 M5): a `Context.Tag` service tracking cumulative Usage across
 * all of a run's leaves in one shared pool. The ceiling gates NEW `agent()` spawns - once spend
 * reaches the target, `admit` fails with a typed `budget-exhausted`, so `while (remaining() > N)` loops
 * terminate. It bounds STARTING work, not a mid-flight kill: a budget trip lets already-running leaves
 * DRAIN (only an explicit cancel interrupts them), so worst-case overshoot is bounded by
 * `(concurrency-cap x per-leaf token cap)`. On resume a cached leaf `record`s its journaled Usage, so
 * budget-dependent control flow replays identically (21/D-013, D-020).
 *
 * Responsible for: the shared-pool spend accounting, the spawn-gate ceiling, and `remaining()` for
 * loop guards, as a `Context.Tag` service with a `Layer`.
 * Not for: the per-leaf token/step caps (those are `opts.tokenBudget`/`opts.stepBudget` on the leaf,
 * M2), the scheduler concurrency cap (concurrency.ts), or journaling (journal.ts).
 */
import { Context, Effect, Layer, Ref } from "effect";
import { WorkflowRunError } from "./errors";
import type { TurnUsage } from "./leaf";

/** The shared-pool budget for one run. `total` null = unbounded (`remaining` is Infinity). */
export interface WorkflowBudget {
  readonly total: number | null;
  /** Output tokens spent across all leaves so far. */
  readonly spent: Effect.Effect<number>;
  /** `max(0, total - spent)`, or `Infinity` when unbounded - the loop-guard value. */
  readonly remaining: Effect.Effect<number>;
  /** Add a leaf's usage to the shared pool (its generated tokens are the spend). */
  readonly record: (usage: TurnUsage) => Effect.Effect<void>;
  /** Gate a NEW spawn: fails `budget-exhausted` once the ceiling is reached; void while under it or
   *  unbounded. Already-running leaves are never gated, so they drain. */
  readonly admit: Effect.Effect<void, WorkflowRunError>;
}

/** The governor as an injectable service. */
export class BudgetGovernor extends Context.Tag("WorkflowBudgetGovernor")<
  BudgetGovernor,
  WorkflowBudget
>() {}

/** Build a fresh shared-pool budget with the given ceiling (null = unbounded). */
export function makeBudget(total: number | null): Effect.Effect<WorkflowBudget> {
  return Ref.make(0).pipe(
    Effect.map((spentRef) => ({
      total,
      spent: Ref.get(spentRef),
      remaining: Ref.get(spentRef).pipe(
        Effect.map((spent) =>
          total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - spent),
        ),
      ),
      record: (usage: TurnUsage) => Ref.update(spentRef, (spent) => spent + usage.output),
      admit:
        total === null
          ? Effect.void
          : Ref.get(spentRef).pipe(
              Effect.flatMap((spent) =>
                spent >= total
                  ? Effect.fail(
                      new WorkflowRunError({
                        reason: "budget-exhausted",
                        detail: `run budget of ${total} tokens is spent (${spent}); no new leaves may spawn`,
                      }),
                    )
                  : Effect.void,
              ),
            ),
    })),
  );
}

/** A `Layer` providing the governor for a run. */
export function budgetLayer(total: number | null): Layer.Layer<BudgetGovernor> {
  return Layer.effect(BudgetGovernor, makeBudget(total));
}

/**
 * Gate one live spawn through the governor, then run it: `admit` (fail-fast if the ceiling is spent),
 * then the leaf, then `record` its usage into the pool. A cached/replayed leaf does NOT go through this
 * (it is not a new spawn); it only `record`s its restored usage.
 */
export function spawnGuarded(
  budget: WorkflowBudget,
  live: Effect.Effect<{ readonly usage: TurnUsage }>,
): Effect.Effect<{ readonly usage: TurnUsage }, WorkflowRunError> {
  return budget.admit.pipe(
    Effect.flatMap(() => live),
    Effect.tap((result) => budget.record(result.usage)),
  );
}
