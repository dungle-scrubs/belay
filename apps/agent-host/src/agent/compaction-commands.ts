import type { ProviderError } from "@host/providers/index";
import type { Lease } from "@host/session/lease";
import { warn } from "@host/transport/log";
import { commas } from "@host/transport/messages";
import type { EmitEvent } from "@host/transport/services";
import { events, type SessionEvent, type TrevorEventInput } from "@trevor/session";
import { Cause, Effect, Exit, Fiber } from "effect";
import type { CompactionController } from "./compaction-controller";
import type { TurnScheduler } from "./turn-scheduler";

/**
 * The compaction command lane, extracted from main.ts (plan 22.3): main.ts constructs
 * {@link makeCompactionCommands} once over its live controller/projection state and keeps
 * dispatching from the scheduler's compaction gate, the /compact command context, and the
 * /compress flow under the same local names.
 *
 * --- cross-turn compaction (D-040..D-043) ---
 * The latest turn's prompt size + window, captured from each assistant.completed usage, drive the
 * between-turn compaction gate (the within-turn airbag is overflow recovery). `floorReached` stops
 * retrying a fold that could not shrink further until a fresh turn moves the needle; `lastProvider`
 * is the model the fold summarizes with (the last turn's provider, per D-043).
 *
 * Responsible for: the between-turn fold gate + trigger (needsCompaction/startCompaction), the
 * manual /compact fold with its ESC-interruptible fiber, and the fold-progress throttle.
 * Not for: the fold plan/summary itself (agent/compaction-controller.ts), or WHEN the idle slot
 * runs the gate (agent/turn-scheduler.ts - main.ts wires these two into it).
 */

/** The live main.ts state the compaction commands read - controller, projection, and lease seams. */
export interface CompactionCommandsDeps {
  /** The host's shared producer id, stamped on the fold's context.compacted event. */
  readonly producerId: string;
  /** Publish one host-authored event to the durable log (main.ts's emit). */
  readonly emit: EmitEvent;
  /** The compaction controller: the fold plan/summary + the budget gate + the floor marker. */
  readonly compactionController: Pick<
    CompactionController,
    "providerOrDefault" | "planFold" | "needed" | "markFloorReached"
  >;
  /** The durable event log right now (main.ts's mutable `historyEvents`). */
  historyEvents(): readonly SessionEvent[];
  /** Whether replay has completed and the host is answering (main.ts's mutable `live` flag). */
  live(): boolean;
  /** The lease: only the leader gates/folds. */
  readonly lease: Pick<Lease, "isLeader">;
  /** Lazy: the TurnScheduler is constructed AFTER this factory (its compaction gate takes
   *  needsCompaction/startCompaction), so the busy check + gate release read it through this. */
  scheduler(): Pick<TurnScheduler, "isBusy" | "finishCompaction">;
}

/** Builds the compaction command lane over the host's live state; main.ts wires it once. */
export function makeCompactionCommands(deps: CompactionCommandsDeps) {
  const { producerId, emit, compactionController, historyEvents, live, lease, scheduler } = deps;

  /** The in-flight MANUAL `/compact` fold, so ESC can interrupt it (the user asked, so they can take
   *  it back). Only the manual fold is tracked - automatic folds are not interruptible (the blocking
   *  one is load-bearing for the next turn). Null when no manual fold is running. */
  let manualCompactFiberValue: Fiber.RuntimeFiber<TrevorEventInput | null, ProviderError> | null =
    null;

  /** The in-flight manual fold's fiber, or null - read by abortRuns (to interrupt it), the
   *  workspace-switch blocker, and the leadership dangling-/compact reap. */
  function manualCompactFiber(): Fiber.RuntimeFiber<TrevorEventInput | null, ProviderError> | null {
    return manualCompactFiberValue;
  }

  /** Emit at most one progress tick per this many summary tokens, so a streaming fold publishes a
   *  bounded handful of advisory `context.compacting` events rather than one per delta. */
  const COMPACT_PROGRESS_TOKEN_STEP = 40;

  /** Builds a throttled progress callback for one fold: emits an honest live `context.compacting`
   *  tick (real tokens streamed ÷ budget) as the summary streams, fire-and-forget. The web fills a
   *  transient bar from these and drops it when the matching `context.compacted` lands. */
  function compactionProgress(foldId: string): (tokens: number, budget: number) => void {
    // -1 = nothing emitted yet (so the first tick always fires, even at 0). A plain 0 sentinel breaks
    // the throttle while the summary sits at 0 tokens - the model ingesting a large fold prompt before
    // its first output token - flooding the log with identical tokens:0 ticks.
    let lastEmitted = -1;
    return (tokens, budget) => {
      if (lastEmitted >= 0 && tokens - lastEmitted < COMPACT_PROGRESS_TOKEN_STEP) {
        return;
      }
      lastEmitted = tokens;
      emit(events.contextCompacting({ foldId, tokens, budget })).catch(() => {});
    };
  }

  /** True when a fold should run before the next turn: live leader, over COMPACT_WHEN of the window,
   *  and not already at the fold floor. Live + leader gated so replay/standbys never gate (a fold that
   *  cannot change the budget there would loop the scheduler). */
  function needsCompaction(): boolean {
    return compactionController.needed(live() && lease.isLeader());
  }

  /**
   * Kicks off ONE fold off the idle slot: plan + summarize + emit `context.compacted`. The fold's own
   * echo (handled in main.ts's handleEvent) admits it, updates the budget estimate, and releases the
   * gate. A no-fold result (nothing left to fold) or any failure marks the floor and releases the gate
   * directly, so the gate never loops. Not live/leader (or no provider) just releases the gate.
   */
  function startCompaction(): void {
    const provider = compactionController.providerOrDefault();
    if (!live() || !lease.isLeader() || !provider) {
      scheduler().finishCompaction();
      return;
    }
    const foldId = crypto.randomUUID();
    Effect.runFork(
      compactionController
        .planFold({
          provider,
          events: historyEvents().slice(),
          producerId,
          foldId,
          onProgress: compactionProgress(foldId),
        })
        .pipe(
          Effect.flatMap((event) =>
            event
              ? // Its echo (the context.compacted case in handleEvent) admits it + releases the gate.
                Effect.promise(() => emit(event))
              : Effect.sync(() => {
                  compactionController.markFloorReached();
                  scheduler().finishCompaction();
                }),
          ),
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              warn("host", "compaction failed", { cause: Cause.pretty(cause) });
              compactionController.markFloorReached();
              scheduler().finishCompaction();
            }),
          ),
        ),
    );
  }

  /**
   * Forces one compaction fold now (the /compact command), at ANY context level: `force` folds every
   * completed turn regardless of the budget (the user asked - their choice), not just when over 80%.
   * Same plan + summary + emit path, whose echo admits the fold. Refuses only while a turn is active
   * (a fold must not overlap a turn, D-041), and reports when there's genuinely nothing to fold.
   */
  async function forceCompact(): Promise<string> {
    if (scheduler().isBusy()) {
      return "A turn is in progress — run /compact again once it finishes.";
    }
    if (manualCompactFiberValue) {
      return "A compaction is already running.";
    }
    const provider = compactionController.providerOrDefault();
    if (!provider) {
      return "No provider available to summarize.";
    }
    const foldId = crypto.randomUUID();
    // Forked (not awaited inline) so ESC can interrupt it - the summary's provider stream aborts on
    // interrupt. On interrupt nothing is emitted, so the context is left exactly as it was.
    const fiber = Effect.runFork(
      compactionController.planFold({
        provider,
        events: historyEvents().slice(),
        producerId,
        foldId,
        onProgress: compactionProgress(foldId),
        force: true, // fold regardless of the current context %
      }),
    );
    manualCompactFiberValue = fiber;
    const exit = await Effect.runPromise(Fiber.await(fiber));
    manualCompactFiberValue = null;
    if (Exit.isFailure(exit)) {
      if (Cause.isInterruptedOnly(exit.cause)) {
        return "Compaction cancelled."; // the user pressed ESC; no fold applied
      }
      warn("host", "compaction failed", { cause: Cause.pretty(exit.cause) });
      return "Compaction failed.";
    }
    const event = exit.value;
    if (!event) {
      return "Nothing to compact — no completed turns to fold yet.";
    }
    await emit(event); // the echo admits the fold and updates the budget estimate
    return `✓ compacted ~${commas(Number(event.payload.tokensBefore))} → ~${commas(Number(event.payload.tokensAfter))} tokens`;
  }

  return { needsCompaction, startCompaction, forceCompact, manualCompactFiber };
}

/** The factory's product surface, so consumers derive signatures instead of re-declaring them. */
export type CompactionCommandsApi = ReturnType<typeof makeCompactionCommands>;
