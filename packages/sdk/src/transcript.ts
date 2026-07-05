import { decodeTrevorEvent, type SessionEvent } from "@trevor/session";

/**
 * The SDK transcript projection (plan 28 M4): a lightweight, headless-appropriate fold of a session's
 * durable log into an ordered list of conversational entries. It is deliberately NOT the web's rich
 * transcript fold (which owns reasoning ghosting, tool detail takeovers, compaction cards, and syntax
 * highlighting) - a headless consumer (a CLI `transcript` command, an eval scorer) wants the plain
 * sequence of who-said-what plus the tools a turn ran, and reads raw events (`client.readLog`) when it
 * needs more. Every entry is derived from the durable log; nothing here renders.
 */

export type TranscriptRole = "user" | "assistant" | "command" | "tool" | "limit";

/** The structured usage-limit signal carried on a `limit` entry (plan 44.4), so a headless consumer
 *  (an eval scorer, the supervisor) reads provider/status/scope/reset without re-parsing `text`. */
export interface TranscriptLimit {
  readonly provider: string;
  readonly status: string;
  readonly scope: string;
  readonly resetsAt?: number;
  readonly utilization?: number;
}

export interface TranscriptEntry {
  readonly role: TranscriptRole;
  /** The turn correlation id, when the entry belongs to a run (assistant/tool entries). */
  readonly runId: string | null;
  /** The entry's text: the user message, the assistant's final answer, or a command's rendered result. */
  readonly text: string;
  /** For a `tool` entry, the tool name; otherwise undefined. */
  readonly tool?: string;
  /** For a `limit` entry, the structured usage-limit signal (plan 44.4); otherwise undefined. */
  readonly limit?: TranscriptLimit;
  /** The durable event's `createdAt`, so a consumer can order/scope by time. */
  readonly at: string;
  /** The durable log sequence number of the source event. */
  readonly seq: number;
}

export interface Transcript {
  readonly entries: readonly TranscriptEntry[];
}

/**
 * Folds a raw durable log into a {@link Transcript}. It keeps the entries a headless consumer needs:
 * `user.message` prompts, terminal `assistant.completed` answers, `command.result` outputs,
 * `tool.completed` breadcrumbs (name only), and `assistant.limit` usage-limit signals (plan 44.4, so a
 * headless consumer can read + act on an approaching/reached limit). Intermediate deltas/thinking/started
 * events are omitted - a consumer that wants the streaming detail reads the raw log. Unknown event types
 * are ignored so the projection is forward-compatible.
 */
export function projectTranscript(events: readonly SessionEvent[]): Transcript {
  const entries: TranscriptEntry[] = [];
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    if (decoded.type === "user.message") {
      entries.push({
        role: "user",
        runId: null,
        text: decoded.text,
        at: event.createdAt,
        seq: event.seq,
      });
    } else if (decoded.type === "assistant.completed") {
      entries.push({
        role: "assistant",
        runId: decoded.runId,
        text: decoded.text,
        at: event.createdAt,
        seq: event.seq,
      });
    } else if (decoded.type === "command.result") {
      entries.push({
        role: "command",
        runId: null,
        text: decoded.text,
        at: event.createdAt,
        seq: event.seq,
      });
    } else if (decoded.type === "tool.completed") {
      entries.push({
        role: "tool",
        runId: decoded.runId,
        text: decoded.result,
        tool: decoded.name,
        at: event.createdAt,
        seq: event.seq,
      });
    } else if (decoded.type === "assistant.limit") {
      // A usage-limit signal (plan 44.4): a plain-text summary a scorer can grep, plus the structured
      // `limit` so automation reads provider/status/scope/reset without re-parsing.
      entries.push({
        role: "limit",
        runId: null,
        text: `usage limit ${decoded.status} (${decoded.provider}, ${decoded.scope})`,
        limit: {
          provider: decoded.provider,
          status: decoded.status,
          scope: decoded.scope,
          ...(decoded.resetsAt !== undefined ? { resetsAt: decoded.resetsAt } : {}),
          ...(decoded.utilization !== undefined ? { utilization: decoded.utilization } : {}),
        },
        at: event.createdAt,
        seq: event.seq,
      });
    }
  }
  return { entries };
}
