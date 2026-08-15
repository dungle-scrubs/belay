/**
 * Responsible for: the host's cross-turn compaction bookkeeping - the retained replay/budget
 * window, last measured usage, fold snapshots, and the needed()/planFold() surface callers drive.
 * Not for: fold planning or summarization - compaction-planner.ts and compactor.ts.
 */
import type { SessionEvent, TrevorEventInput } from "@belay/session";
import type { Effect } from "effect";
import type { Provider, ProviderError } from "../providers";
import { COMPACT_WHEN, overBudget, runCompaction } from "./compactor";

export interface CompactionFoldSnapshot {
  readonly throughSeq: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export interface CompactionBudgetSnapshot {
  readonly lastInput: number;
  readonly latestWindow: number;
  readonly retainedBudgetWindow: number;
  readonly provider: {
    readonly id: string;
    readonly model: string;
  } | null;
  readonly floorReached: boolean;
  readonly lastFold: CompactionFoldSnapshot | null;
}

/** The per-fold pieces a caller supplies; the controller fills the rest (provider, window, input) from
 *  its captured state, so a fold call site stops re-threading the controller's internals. */
export interface CompactionFoldRequest {
  readonly provider: Provider;
  readonly events: readonly SessionEvent[];
  readonly producerId: string;
  readonly foldId: string;
  readonly onProgress?: (tokens: number, budget: number) => void;
  /** Fold regardless of the current context %; the /compact path forces, the idle-slot path doesn't. */
  readonly force?: boolean;
}

export class CompactionController {
  private lastInputValue = 0;
  private lastWindowValue = 0;
  /** The window the shared history will REPLAY against for budgeting (03.2 D-005): the foreground /
   *  session-minimum window, retained so a larger transient (e.g. a 1M-window delegate/sub) turn can't
   *  lift the trigger above the window that actually replays the durable history. Re-anchored only on a
   *  genuine foreground-model change. 0 until the first positive window is seen. */
  private budgetWindowValue = 0;
  private floorReached = false;
  private lastProviderValue: Provider | undefined;
  private lastFoldValue: CompactionFoldSnapshot | null = null;

  /** `defaultProvider` is the fallback when no turn has set a provider yet (the registry default). */
  constructor(private readonly defaultProvider: Provider | undefined) {}

  get lastFold(): CompactionFoldSnapshot | null {
    return this.lastFoldValue;
  }

  noteProvider(provider: Provider, budgetWindow?: number): void {
    // A genuine foreground-model change re-anchors the replay window (03.2 D-005): an upgrade or
    // downgrade to a DIFFERENT foreground model adopts its own window on the next usage, so the prior
    // model's window never permanently over- or under-compacts the new one. The same foreground model
    // across turns keeps the retained minimum, so a transient larger sub-turn window can't widen it.
    if (
      this.lastProviderValue &&
      (this.lastProviderValue.id !== provider.id || this.lastProviderValue.model !== provider.model)
    ) {
      this.budgetWindowValue = 0;
    }
    this.lastProviderValue = provider;
    if (budgetWindow !== undefined) {
      this.retainBudgetWindow(budgetWindow);
    }
  }

  resetForReplay(): void {
    this.lastInputValue = 0;
    this.lastWindowValue = 0;
    this.budgetWindowValue = 0;
    this.floorReached = false;
    this.lastProviderValue = undefined;
    this.lastFoldValue = null;
  }

  /** The provider a fold/control prompt runs on: the last turn's, else the registry default. */
  providerOrDefault(): Provider | undefined {
    return this.lastProviderValue ?? this.defaultProvider;
  }

  /**
   * Builds the Effect for ONE compaction fold, packaging the captured window + input (the controller's
   * own state) into `runCompaction` so neither the idle-slot nor the /compact caller re-assembles its
   * positional arg list. The caller forks the returned Effect; its `context.compacted` result (or
   * null on nothing-to-fold) flows back through the normal echo path.
   */
  planFold(plan: CompactionFoldRequest): Effect.Effect<TrevorEventInput | null, ProviderError> {
    return runCompaction(
      plan.provider,
      plan.events,
      this.budgetWindow(),
      plan.producerId,
      this.lastInputValue,
      plan.foldId,
      plan.onProgress,
      plan.force,
    );
  }

  /**
   * Captures the latest turn's budget input + served window. The budget input is the LARGER of the
   * provider's reported `input` and the assembled-history chars/4 `estimate` (03.2 D-002): a provider
   * that under-counts (cached/billable input below the full prompt) no longer hides a history the
   * pre-send guard would trip on, so the trigger, the planner, and the guard all measure the same size.
   * `estimate` defaults to 0 (no assembled measurement), leaving the provider input as the sole metric.
   */
  noteUsage(input: number, window: number, estimate = 0): void {
    this.lastInputValue = Math.max(input, estimate);
    this.lastWindowValue = window;
    this.retainBudgetWindow(window);
  }

  /**
   * Retains the window the shared history replays against (03.2 D-005): within one foreground turn the
   * budget window only ever TIGHTENS, so a larger interleaved (delegate/sub) turn's window never lifts
   * the trigger off the smaller window that will actually replay the durable history. A genuine
   * foreground-model change clears it (noteProvider) so the next turn re-anchors to its own window.
   */
  private retainBudgetWindow(window: number): void {
    if (window <= 0) {
      return;
    }
    this.budgetWindowValue =
      this.budgetWindowValue > 0 ? Math.min(this.budgetWindowValue, window) : window;
  }

  /** The window the over-budget + fold decisions budget against: the retained foreground/min replay
   *  window, falling back to the last served window before any positive window has been retained. */
  private budgetWindow(): number {
    return this.budgetWindowValue > 0 ? this.budgetWindowValue : this.lastWindowValue;
  }

  /**
   * The prior turn's measured prompt size + served window (the same real numbers the ctx meter
   * renders), for carry-forward seeding of the next turn's context-pressure gate at step 0 (03.1
   * D-002). `undefined` until a turn has reported a positive window, so a session's first turn seeds
   * nothing and the loop behaves exactly as today. Read-only: it carries no fraction logic - the gate
   * owns the threshold.
   */
  usageSeed(): { readonly input: number; readonly contextWindow: number } | undefined {
    if (this.lastWindowValue <= 0) {
      return undefined;
    }
    return { input: this.lastInputValue, contextWindow: this.lastWindowValue };
  }

  noteTurnCompleted(
    usage?: { readonly input: number; readonly contextWindow: number },
    estimate = 0,
  ): void {
    if (usage) {
      this.noteUsage(usage.input, usage.contextWindow, estimate);
    }
    this.floorReached = false;
  }

  noteCompacted(snapshot: CompactionFoldSnapshot): void {
    this.lastInputValue = snapshot.tokensAfter;
    this.lastFoldValue = snapshot;
  }

  markFloorReached(): void {
    this.floorReached = true;
  }

  needed(liveLeader: boolean): boolean {
    return (
      liveLeader &&
      !this.floorReached &&
      overBudget(this.lastInputValue, this.budgetWindow(), COMPACT_WHEN)
    );
  }

  debug(): CompactionBudgetSnapshot {
    return {
      lastInput: this.lastInputValue,
      latestWindow: this.lastWindowValue,
      retainedBudgetWindow: this.budgetWindow(),
      provider: this.lastProviderValue
        ? { id: this.lastProviderValue.id, model: this.lastProviderValue.model }
        : null,
      floorReached: this.floorReached,
      lastFold: this.lastFoldValue,
    };
  }
}
