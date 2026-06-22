import type { SessionEvent } from "@trevor/richter";

export type Usage = { input: number; output: number; contextWindow: number; genMs: number };

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
  error?: string;
  overflow?: string;
};
export type ToolMessage = { kind: "tool"; id: string; name: string; args: string; done: boolean };
export type Message = { kind: "user"; id: string; text: string } | AssistantMessage | ToolMessage;

/**
 * Coalesces the raw event log into a transcript in arrival order. An assistant turn
 * is split into segments at each tool call: the open segment is finalized when a tool
 * starts, so thinking/text that comes *after* a tool renders below it (not lumped into
 * one bubble at the top). started only records the run's model/warmth; a segment is
 * created lazily on the first thinking/text, so an empty turn never leaves a stray bubble.
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
    const payload = event.payload;
    const runId = String(payload.runId ?? event.eventId);
    if (event.type === "user.message") {
      messages.push({ kind: "user", id: event.eventId, text: String(payload.text ?? "") });
    } else if (event.type === "assistant.started") {
      runMeta.set(runId, {
        model: typeof payload.model === "string" ? payload.model : "model",
        warm: payload.warm === true,
        provider: typeof payload.provider === "string" ? payload.provider : undefined,
      });
    } else if (event.type === "assistant.delta") {
      openSegment(runId).text += String(payload.text ?? "");
    } else if (event.type === "assistant.thinking") {
      openSegment(runId).thinking += String(payload.text ?? "");
    } else if (event.type === "assistant.overflow") {
      openSegment(runId).overflow = String(payload.reason ?? "context overflow");
    } else if (event.type === "tool.started") {
      // Finalize the open segment so the next thinking/text starts a new one below the tool.
      const open = openByRun.get(runId);
      if (open) {
        open.done = true;
        openByRun.delete(runId);
      }
      const callId = String(payload.callId ?? event.eventId);
      const tool: ToolMessage = {
        kind: "tool",
        id: callId,
        name: String(payload.name ?? "tool"),
        args: String(payload.arguments ?? ""),
        done: false,
      };
      toolByCall.set(callId, tool);
      messages.push(tool);
    } else if (event.type === "tool.completed") {
      const tool = toolByCall.get(String(payload.callId ?? event.eventId));
      if (tool) {
        tool.done = true;
      }
    } else if (event.type === "assistant.completed") {
      // Land the final state on the run's last segment (or a fresh one if the turn
      // produced nothing visible, so an error still has somewhere to show).
      const segment = openByRun.get(runId) ?? lastByRun.get(runId) ?? openSegment(runId);
      segment.done = true;
      openByRun.delete(runId);
      if (typeof payload.error === "string") {
        segment.error = payload.error;
      }
      if (!segment.text && !segment.thinking) {
        segment.text = String(payload.text ?? "");
      }
      const raw = payload.usage;
      if (raw && typeof raw === "object") {
        const u = raw as Record<string, unknown>;
        segment.usage = {
          input: typeof u.input === "number" ? u.input : 0,
          output: typeof u.output === "number" ? u.output : 0,
          contextWindow: typeof u.contextWindow === "number" ? u.contextWindow : 0,
          genMs: typeof u.genMs === "number" ? u.genMs : 0,
        };
      }
    }
  }
  return messages;
}
