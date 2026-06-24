import {
  type ArtifactRef,
  addBreakdown,
  decodeTrevorEvent,
  type SessionEvent,
  type Usage,
  type UsageBreakdown,
} from "@trevor/session";

export type { ArtifactRef, Usage, UsageBreakdown };

// One assistant *segment*: the run of thinking/text between tool calls. A turn that
// calls tools produces several, interleaved with tool messages in arrival order.
export type AssistantMessage = {
  kind: "assistant";
  id: string;
  runId: string;
  text: string;
  thinking: string;
  done: boolean;
  warm: boolean;
  model: string;
  provider?: string;
  usage?: Usage;
  breakdown?: UsageBreakdown;
  error?: string;
  overflow?: string;
  cancelled?: boolean;
  /** The model ended the turn with no reply (after a retry). */
  noReply?: boolean;
};
export type ToolMessage = {
  kind: "tool";
  id: string;
  name: string;
  args: string;
  done: boolean;
  /** The tool's rendered output (from tool.completed), used by renderers like web_search. */
  result?: string;
};
// An immediate slash command and the host's result for it (the command lane - these
// never go to the model, so they render as their own pair, not assistant turns).
export type CommandMessage = { kind: "command"; id: string; command: string; args: string };
export type CommandResultMessage = {
  kind: "result";
  id: string;
  command: string;
  text: string;
  ok: boolean;
};
// A graceful-overflow-recovery adjustment, rendered inline as a status marker: the
// loop recovered (trimmed a tool result / reduced thinking) and retried. Distinct from
// compaction (durable history summarization, D-036, not yet built).
export type RecoveredMessage = {
  kind: "recovered";
  id: string;
  action: string;
  detail: string;
  reclaimed: number;
};
export type Message =
  | { kind: "user"; id: string; text: string; artifacts: readonly ArtifactRef[] }
  | AssistantMessage
  | ToolMessage
  | CommandMessage
  | CommandResultMessage
  | RecoveredMessage;

/** A live, mid-turn snapshot of the in-flight call: usage drives the ctx meter, the
 *  breakdown drives the Request treemap, both before the turn completes. */
export interface LiveCall {
  readonly usage: Usage;
  readonly breakdown?: UsageBreakdown;
}

/**
 * The in-flight snapshot for the panel: the newest `assistant.progress` from a turn
 * that hasn't completed yet, or `undefined` once the latest turn has finished (so
 * callers fall back to the completed call's authoritative usage + breakdown). Walks
 * back from the newest event and stops at the first completion - a progress seen
 * before any completion means a turn is still streaming.
 */
export function liveCallFrom(events: readonly SessionEvent[]): LiveCall | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const decoded = event ? decodeTrevorEvent(event) : null;
    if (!decoded) {
      continue;
    }
    if (decoded.type === "assistant.completed") {
      return undefined;
    }
    if (decoded.type === "assistant.progress" && decoded.usage) {
      return { usage: decoded.usage, breakdown: decoded.breakdown };
    }
  }
  return undefined;
}

/**
 * Coalesces the raw event log into a transcript in arrival order. An assistant turn
 * is split into segments at each tool call: the open segment is finalized when a tool
 * starts, so thinking/text that comes *after* a tool renders below it (not lumped into
 * one bubble at the top). started only records the run's model/warmth; a segment is
 * created lazily on the first thinking/text, so an empty turn never leaves a stray bubble.
 * Payloads are read through decodeTrevorEvent, so the fold never hand-guards raw fields.
 */
export function toTranscript(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];
  const runMeta = new Map<string, { model: string; warm: boolean; provider?: string }>();
  const openByRun = new Map<string, AssistantMessage>();
  const lastByRun = new Map<string, AssistantMessage>();
  const toolByCall = new Map<string, ToolMessage>();
  let segCount = 0;
  const openSegment = (runId: string): AssistantMessage => {
    let segment = openByRun.get(runId);
    if (!segment) {
      const m = runMeta.get(runId);
      segment = {
        kind: "assistant",
        id: `${runId}:${segCount++}`,
        runId,
        text: "",
        thinking: "",
        done: false,
        warm: m?.warm ?? false,
        model: m?.model ?? "model",
        provider: m?.provider,
      };
      openByRun.set(runId, segment);
      lastByRun.set(runId, segment);
      messages.push(segment);
    }
    return segment;
  };
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    switch (decoded.type) {
      case "user.message":
        messages.push({
          kind: "user",
          id: event.eventId,
          text: decoded.text,
          artifacts: decoded.artifacts,
        });
        break;
      case "user.command":
        if (decoded.command === "/clear") {
          // A clear resets the conversation: drop everything before it (and any in-flight
          // run state) so the transcript starts fresh from this point.
          messages.length = 0;
          runMeta.clear();
          openByRun.clear();
          lastByRun.clear();
          toolByCall.clear();
        }
        messages.push({
          kind: "command",
          id: event.eventId,
          command: decoded.command,
          args: decoded.args,
        });
        break;
      case "command.result":
        messages.push({
          kind: "result",
          id: event.eventId,
          command: decoded.command,
          text: decoded.text,
          ok: decoded.ok,
        });
        break;
      case "assistant.started":
        runMeta.set(decoded.runId, {
          model: decoded.model,
          warm: decoded.warm,
          provider: decoded.provider,
        });
        break;
      case "assistant.delta":
        openSegment(decoded.runId).text += decoded.text;
        break;
      case "assistant.thinking":
        openSegment(decoded.runId).thinking += decoded.text;
        break;
      case "assistant.overflow":
        openSegment(decoded.runId).overflow = decoded.reason;
        break;
      case "assistant.recovered": {
        // Finalize the open segment so the retry's output starts fresh below the marker.
        const open = openByRun.get(decoded.runId);
        if (open) {
          open.done = true;
          openByRun.delete(decoded.runId);
        }
        messages.push({
          kind: "recovered",
          id: event.eventId,
          action: decoded.action,
          detail: decoded.detail,
          reclaimed: decoded.reclaimed,
        });
        break;
      }
      case "tool.started": {
        // Finalize the open segment so the next thinking/text starts a new one below the tool.
        const open = openByRun.get(decoded.runId);
        if (open) {
          open.done = true;
          openByRun.delete(decoded.runId);
        }
        const tool: ToolMessage = {
          kind: "tool",
          id: decoded.callId,
          name: decoded.name,
          args: decoded.arguments,
          done: false,
        };
        toolByCall.set(decoded.callId, tool);
        messages.push(tool);
        break;
      }
      case "tool.completed": {
        const tool = toolByCall.get(decoded.callId);
        if (tool) {
          tool.done = true;
          tool.result = decoded.result;
        }
        break;
      }
      case "assistant.completed": {
        // Land the final state on the run's last segment (or a fresh one if the turn
        // produced nothing visible, so an error still has somewhere to show).
        const segment =
          openByRun.get(decoded.runId) ??
          lastByRun.get(decoded.runId) ??
          openSegment(decoded.runId);
        segment.done = true;
        openByRun.delete(decoded.runId);
        if (decoded.error) {
          segment.error = decoded.error;
        }
        if (decoded.cancelled) {
          segment.cancelled = true;
        }
        if (decoded.noReply) {
          segment.noReply = true;
        }
        if (!segment.text && !segment.thinking) {
          segment.text = decoded.text;
        }
        if (decoded.usage) {
          segment.usage = decoded.usage;
        }
        if (decoded.breakdown) {
          segment.breakdown = decoded.breakdown;
        }
        break;
      }
      default:
        break;
    }
  }
  return messages;
}

/**
 * The SidePanel's whole view-model, folded from the transcript (+ the raw events for the
 * live snapshot) in one place - the single surface that owns the live-vs-completed
 * precedence and the per-category context aggregation. Previously four sibling useMemos
 * in App.tsx fanned out as six props; this collapses them so the panel reads from one
 * object and the context sum can never re-list (and so drift from) the canonical category
 * set - it folds every completed request's breakdown via `addBreakdown`.
 *
 * Request data (ctx meter + Request treemap): the in-flight call wins while a turn
 * streams (live usage/breakdown), else the latest completed call's authoritative data.
 * Context data: the whole session - every completed request's breakdown + tokens summed,
 * so it grows turn over turn. `contextBreakdown`/`contextTokens` stay independently
 * undefined (one can be present without the other) to match the prior behavior.
 */
export interface PanelModel {
  readonly ctxUsed?: number;
  readonly ctxMax?: number;
  readonly totalTokens?: number;
  readonly breakdown?: UsageBreakdown;
  readonly contextBreakdown?: UsageBreakdown;
  readonly contextTokens?: number;
}

export function panelModel(
  transcript: readonly Message[],
  events: readonly SessionEvent[],
): PanelModel {
  // The latest completed call's usage + breakdown (walk back to the newest assistant
  // segment that carries either), for the Request tab / ctx meter when no turn streams.
  let lastCall: AssistantMessage | null = null;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const m = transcript[i];
    if (m?.kind === "assistant" && (m.breakdown || m.usage)) {
      lastCall = m;
      break;
    }
  }

  // The whole-context aggregation: sum every completed request's breakdown (category-
  // driven, via addBreakdown) and its tokens. The two stay independently optional.
  let contextBreakdown: UsageBreakdown | undefined;
  let contextTokens: number | undefined;
  for (const m of transcript) {
    if (m.kind !== "assistant") {
      continue;
    }
    if (m.breakdown) {
      contextBreakdown = contextBreakdown
        ? addBreakdown(contextBreakdown, m.breakdown)
        : m.breakdown;
    }
    if (m.usage) {
      contextTokens = (contextTokens ?? 0) + m.usage.input + m.usage.output;
    }
  }

  // The in-flight call wins for Request data while a turn streams; else the completed call.
  const live = liveCallFrom(events);
  const ctxUsed = live?.usage.input ?? lastCall?.usage?.input;
  const ctxMax = live?.usage.contextWindow ?? lastCall?.usage?.contextWindow;
  const totalTokens = live
    ? live.usage.input + live.usage.output
    : lastCall?.usage
      ? lastCall.usage.input + lastCall.usage.output
      : undefined;
  const breakdown = live?.breakdown ?? lastCall?.breakdown;

  return { ctxUsed, ctxMax, totalTokens, breakdown, contextBreakdown, contextTokens };
}
