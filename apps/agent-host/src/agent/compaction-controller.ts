import type { Provider } from "../providers";
import { COMPACT_WHEN, overBudget } from "./compactor";

export interface CompactionFoldSnapshot {
  readonly throughSeq: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export class CompactionController {
  private lastInputValue = 0;
  private lastWindowValue = 0;
  private floorReached = false;
  private lastProviderValue: Provider | undefined;
  private lastFoldValue: CompactionFoldSnapshot | null = null;

  get lastInput(): number {
    return this.lastInputValue;
  }

  get lastWindow(): number {
    return this.lastWindowValue;
  }

  get lastFold(): CompactionFoldSnapshot | null {
    return this.lastFoldValue;
  }

  noteProvider(provider: Provider): void {
    this.lastProviderValue = provider;
  }

  provider(fallback: Provider | undefined): Provider | undefined {
    return this.lastProviderValue ?? fallback;
  }

  noteUsage(input: number, window: number): void {
    this.lastInputValue = input;
    this.lastWindowValue = window;
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
