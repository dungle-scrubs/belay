import type { SessionEvent, TrevorEventInput } from "@trevor/session";
import type { Effect } from "effect";
import type { Provider, ProviderError } from "../providers";
import { COMPACT_WHEN, overBudget, runCompaction } from "./compactor";

export interface CompactionFoldSnapshot {
  readonly throughSeq: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

/** The per-fold pieces a caller supplies; the controller fills the rest (provider, window, input) from
 *  its captured state, so a fold call site stops re-threading the controller's internals. */
export interface FoldPlan {
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
  private floorReached = false;
  private lastProviderValue: Provider | undefined;
  private lastFoldValue: CompactionFoldSnapshot | null = null;

  /** `defaultProvider` is the fallback when no turn has set a provider yet (the registry default). */
  constructor(private readonly defaultProvider: Provider | undefined) {}

  get lastFold(): CompactionFoldSnapshot | null {
    return this.lastFoldValue;
  }

  noteProvider(provider: Provider): void {
    this.lastProviderValue = provider;
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
  planFold(plan: FoldPlan): Effect.Effect<TrevorEventInput | null, ProviderError> {
    return runCompaction(
      plan.provider,
      plan.events,
      this.lastWindowValue,
      plan.producerId,
      this.lastInputValue,
      plan.foldId,
      plan.onProgress,
      plan.force,
    );
  }

  noteUsage(input: number, window: number): void {
    this.lastInputValue = input;
    this.lastWindowValue = window;
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

  noteTurnCompleted(usage?: { readonly input: number; readonly contextWindow: number }): void {
    if (usage) {
      this.noteUsage(usage.input, usage.contextWindow);
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
      overBudget(this.lastInputValue, this.lastWindowValue, COMPACT_WHEN)
    );
  }
}
