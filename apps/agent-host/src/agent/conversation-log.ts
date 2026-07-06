import { decodeTrevorEvent, type SessionEvent } from "@trevor/session";
import type { ChatMessage } from "../providers";
import { clipLine } from "../tools/shared";
import { buildHistory } from "./history-projection";

/**
 * Owns the host's live conversation projection and the durable events it is projected from.
 *
 * Responsible for: keeping `history === buildHistory(events)` at turn boundaries, recording
 * projection-affecting events with a rebuild, recording delayed events without a rebuild, and exposing
 * read-only/snapshot access for callers that need prompt history or the durable log.
 * Not for: publishing events to the durable store, scheduling turns, or deciding which event types are
 * admitted vs recorded.
 */
export class ConversationLog {
  private readonly selfProducerId: string;
  private promptHistory: ChatMessage[] = [];
  private durableEvents: SessionEvent[] = [];

  constructor(opts: { readonly selfProducerId: string }) {
    this.selfProducerId = opts.selfProducerId;
  }

  /** The current prompt projection. Treat as read-only; use `historySnapshot` before mutation. */
  history(): readonly ChatMessage[] {
    return this.promptHistory;
  }

  /** A copy of the current prompt projection for work that must own its array. */
  historySnapshot(): ChatMessage[] {
    return this.promptHistory.slice();
  }

  /** The durable events seen by this connection. Treat as read-only; use `eventsSnapshot` to own it. */
  events(): readonly SessionEvent[] {
    return this.durableEvents;
  }

  /** A copy of the durable events seen by this connection. */
  eventsSnapshot(): SessionEvent[] {
    return this.durableEvents.slice();
  }

  /** Admit an event that changes the prompt projection, then rebuild from the paired durable events. */
  admit(event: SessionEvent): void {
    this.durableEvents.push(event);
    this.promptHistory = buildHistory(this.durableEvents, { selfProducerId: this.selfProducerId });
  }

  /**
   * Record an event that should be available to the next turn-boundary rebuild without rebuilding now.
   * Tool activity and task snapshots use this path to avoid re-folding the full log during a turn.
   */
  record(event: SessionEvent): void {
    this.durableEvents.push(event);
  }

  /** Reset transient connection state before replay rebuilds it. */
  reset(): void {
    this.promptHistory = [];
    this.durableEvents = [];
  }

  /** A short session label from the first user prompt, falling back to the session id. */
  label(fallback: string): string {
    for (const event of this.durableEvents) {
      const decoded = decodeTrevorEvent(event);
      if (decoded?.type === "user.message" && decoded.text.trim()) {
        return clipLine(decoded.text, 60);
      }
    }
    return fallback;
  }

  /** Inspectable state for /doctor or targeted debug logs without exposing mutable arrays. */
  debugInfo(): {
    readonly eventCount: number;
    readonly historyLength: number;
    readonly lastSeq: number | null;
  } {
    const last = this.durableEvents.at(-1);
    return {
      eventCount: this.durableEvents.length,
      historyLength: this.promptHistory.length,
      lastSeq: typeof last?.seq === "number" ? last.seq : null,
    };
  }
}
