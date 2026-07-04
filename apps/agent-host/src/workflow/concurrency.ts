/**
 * The structured-concurrency primitives the orchestration is written in: `parallel` (a barrier
 * fan-out), `pipeline` (per-item staged flow with no barrier between stages), and the `phase`/`log`
 * progress emitters. They run over `Effect.all` with a runtime concurrency cap and a lifetime-cap
 * backstop, and observe each leaf's TYPED result (never a thrown exception): a leaf failure degrades
 * to `null` ONLY AFTER emitting a typed `leaf-failed` event carrying the structured cause (21/D-008,
 * owned here in M3 - M8 only adds spans over it), unless opt-in strict mode (`onError:'fail'`) rejects
 * the whole batch instead.
 *
 * Responsible for: the fan-out / pipeline / phase / log primitives, the concurrency + lifetime caps,
 * and the fail-soft-null-with-emission vs strict-reject policy.
 * Not for: running a single leaf (leaf.ts / leaf-host.ts), the run journal (M4), or the budget
 * governor (M5).
 */
import { Effect, Ref } from "effect";
import { WorkflowRunError } from "./errors";
import type { LeafFailure, LeafResult, LeafSuccess } from "./leaf";
import { consumeOrdinal, type Ordinal, withChildSlot } from "./ordinal";

/** The default runtime concurrency cap: how many leaves run at once before excess queues. */
export const DEFAULT_CONCURRENCY = 8;
/** The most items one `parallel`/`pipeline` call may take (an explicit error past it, not a silent cut). */
export const MAX_ITEMS_PER_CALL = 4096;
/** The lifetime-cap backstop: the most leaves one run may ever start (a runaway-loop guard). */
export const DEFAULT_MAX_TOTAL_LEAVES = 1000;

/** The progress/failure emission seam the primitives own (wired to `workflow.*` events in M4). */
export interface WorkflowEmit {
  /** Emit a typed leaf-failed event carrying the structured cause, BEFORE a fail-soft null (D-008). */
  readonly leafFailed: (failure: LeafFailure) => Effect.Effect<void>;
  /** Emit a narrator progress line. */
  readonly log: (message: string) => Effect.Effect<void>;
  /** Emit a phase marker that buckets subsequent leaves in the run view. */
  readonly phase: (title: string) => Effect.Effect<void>;
}

/** The run-scoped scheduler both primitives share: the emitter, the caps, and the lifetime counter. */
export interface WorkflowScheduler {
  readonly emit: WorkflowEmit;
  readonly concurrency: number;
  readonly maxTotalLeaves: number;
  readonly started: Ref.Ref<number>;
}

/** Build a scheduler for one run (a fresh lifetime counter). */
export function makeScheduler(
  emit: WorkflowEmit,
  options: { readonly concurrency?: number; readonly maxTotalLeaves?: number } = {},
): Effect.Effect<WorkflowScheduler> {
  return Ref.make(0).pipe(
    Effect.map((started) => ({
      emit,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      maxTotalLeaves: options.maxTotalLeaves ?? DEFAULT_MAX_TOTAL_LEAVES,
      started,
    })),
  );
}

/** The value a successful leaf yields to the orchestration: its schema object if any, else its text. */
function unwrap(result: LeafSuccess): unknown {
  return result.value !== undefined ? result.value : result.text;
}

export interface BatchOptions {
  /** `'null'` (default) degrades a failed leaf to null after emitting; `'fail'` rejects the batch. */
  readonly onError?: "null" | "fail";
}

/** Run one leaf thunk under the lifetime-cap guard, then map its typed result to a value / null / a
 *  strict reject - emitting `leaf-failed` before any fail-soft null (D-008). */
function runLeafThunk(
  scheduler: WorkflowScheduler,
  thunk: () => Effect.Effect<LeafResult>,
  onError: "null" | "fail",
): Effect.Effect<unknown, WorkflowRunError> {
  return Effect.gen(function* () {
    const count = yield* Ref.updateAndGet(scheduler.started, (n) => n + 1);
    if (count > scheduler.maxTotalLeaves) {
      return yield* Effect.fail(
        new WorkflowRunError({
          reason: "lifetime-cap",
          detail: `run exceeded the lifetime cap of ${scheduler.maxTotalLeaves} leaves`,
        }),
      );
    }
    const result = yield* thunk();
    if (result.ok) {
      return unwrap(result);
    }
    yield* scheduler.emit.leafFailed(result);
    if (onError === "fail") {
      return yield* Effect.fail(
        new WorkflowRunError({ reason: "strict-failure", detail: result.cause }),
      );
    }
    return null;
  });
}

function assertCallSize(count: number): Effect.Effect<void, WorkflowRunError> {
  return count > MAX_ITEMS_PER_CALL
    ? Effect.fail(
        new WorkflowRunError({
          reason: "call-too-large",
          detail: `a single call takes at most ${MAX_ITEMS_PER_CALL} items (got ${count})`,
        }),
      )
    : Effect.void;
}

/**
 * A BARRIER fan-out: run every thunk concurrently (bounded by the cap), await all, and return their
 * values in order - a failed leaf is `null` (default) after its `leaf-failed` emission, or the whole
 * batch rejects with a typed `WorkflowRunError` in strict mode.
 */
export function parallel(
  scheduler: WorkflowScheduler,
  thunks: ReadonlyArray<() => Effect.Effect<LeafResult>>,
  options: BatchOptions = {},
): Effect.Effect<ReadonlyArray<unknown>, WorkflowRunError> {
  const onError = options.onError ?? "null";
  return assertCallSize(thunks.length).pipe(
    Effect.flatMap(() => consumeOrdinal),
    Effect.flatMap((base: Ordinal) =>
      Effect.all(
        thunks.map((thunk, index) =>
          withChildSlot([...base, index], runLeafThunk(scheduler, thunk, onError)),
        ),
        { concurrency: scheduler.concurrency },
      ),
    ),
  );
}

/** One pipeline stage: given the prior stage's value, the original item, and its index, produce a leaf. */
export type PipelineStage<T> = (
  previous: unknown,
  item: T,
  index: number,
) => Effect.Effect<LeafResult>;

/**
 * A per-item staged flow with NO barrier between stages: each item runs its own stage chain, so item A
 * can be in stage 3 while item B is still in stage 1 (items run concurrently, bounded by the cap). A
 * stage's failed leaf drops that item to `null` (after emitting `leaf-failed`) and skips its remaining
 * stages; strict mode rejects the run instead.
 */
export function pipeline<T>(
  scheduler: WorkflowScheduler,
  items: readonly T[],
  stages: ReadonlyArray<PipelineStage<T>>,
  options: BatchOptions = {},
): Effect.Effect<ReadonlyArray<unknown>, WorkflowRunError> {
  const onError = options.onError ?? "null";
  const runItem = (
    base: Ordinal,
    item: T,
    index: number,
  ): Effect.Effect<unknown, WorkflowRunError> =>
    Effect.gen(function* () {
      let previous: unknown;
      for (const [stageIndex, stage] of stages.entries()) {
        const value = yield* withChildSlot(
          [...base, index, stageIndex],
          runLeafThunk(scheduler, () => stage(previous, item, index), onError),
        );
        if (value === null) {
          return null;
        }
        previous = value;
      }
      return previous;
    });
  return assertCallSize(items.length).pipe(
    Effect.flatMap(() => consumeOrdinal),
    Effect.flatMap((base: Ordinal) =>
      Effect.all(
        items.map((item, index) => runItem(base, item, index)),
        { concurrency: scheduler.concurrency },
      ),
    ),
  );
}

/** Start a new phase: subsequent leaves bucket under `title` in the run view. */
export function phase(scheduler: WorkflowScheduler, title: string): Effect.Effect<void> {
  return scheduler.emit.phase(title);
}

/** Emit a narrator progress line. */
export function log(scheduler: WorkflowScheduler, message: string): Effect.Effect<void> {
  return scheduler.emit.log(message);
}
