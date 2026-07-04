/**
 * The deterministic CALL ORDINAL that keys each `agent()` INVOCATION for the run journal + resume
 * (21/D-019). An ordinal is a structural path (a `number[]`): a fiber-local slot context carries the
 * current path + a per-slot program-order counter, so every `agent()` call derives `[...path, next()]`.
 * The concurrency primitives push a child slot per array-index / (item, stage), so two IDENTICAL
 * parallel leaves and a worker-plus-retry each get a DISTINCT ordinal - not a content match. Because
 * ordinals are assigned by structural position (not runtime completion order), out-of-order appends
 * still reconstruct call -> result on replay.
 *
 * Responsible for: the fiber-local ordinal slot context and the consume/child/root scoping helpers.
 * Not for: journaling or the cache (journal.ts), or the primitives that push child slots
 * (concurrency.ts).
 */
import { Effect, FiberRef } from "effect";

/** A call ordinal: the structural path to one `agent()` invocation. */
export type Ordinal = readonly number[];

/** A stable string key for a `Map`, e.g. `[1, 0, 2] -> "1.0.2"`. */
export const ordinalKey = (ordinal: Ordinal): string => ordinal.join(".");

/** One slot: the path prefix its leaves extend, and a program-order counter for calls within it. */
interface SlotContext {
  readonly path: Ordinal;
  readonly next: () => number;
}

function makeSlot(path: Ordinal): SlotContext {
  let counter = 0;
  return { path, next: () => counter++ };
}

/** The fiber-local current slot. A fresh root per run (via `withRootSlot`); each parallel/pipeline
 *  child fiber overwrites it with its own child slot (via `withChildSlot`), so counters never mix. */
export const SlotCtxRef = FiberRef.unsafeMake<SlotContext>(makeSlot([]));

/** Consume the next ordinal in the current slot - the key for one `agent()` invocation. */
export const consumeOrdinal: Effect.Effect<Ordinal> = Effect.gen(function* () {
  const ctx = yield* FiberRef.get(SlotCtxRef);
  return [...ctx.path, ctx.next()];
});

/**
 * Run `effect` under a fresh child slot rooted at `basePath` - its `agent()` calls key under it (and a
 * retry within it gets the next intra-slot index). `Effect.locally` SCOPES the slot to `effect` and
 * restores the caller's slot after: a bare `FiberRef.set` would leak (a fan-out's "child value wins"
 * join clobbers the parent slot, and a sequential set outlives the block), so a later `agent()` in the
 * body would derive a corrupt ordinal.
 */
export function withChildSlot<A, E, R>(
  basePath: Ordinal,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.locally(effect, SlotCtxRef, makeSlot(basePath));
}

/** Run a whole run's orchestration under a fresh root slot, so ordinals start at `[0]` every run. */
export function withRootSlot<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.locally(effect, SlotCtxRef, makeSlot([]));
}
