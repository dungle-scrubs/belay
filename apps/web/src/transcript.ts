import {
  type ArtifactRef,
  decodeTrevorEvent,
  type SessionEvent,
  type Usage,
} from "@trevor/richter";

export type { ArtifactRef, Usage };

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
  cancelled?: boolean;
};
export type ToolMessage = { kind: "tool"; id: string; name: string; args: string; done: boolean };
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
export type Message =
  | { kind: "user"; id: string; text: string; artifacts: readonly ArtifactRef[] }
  | AssistantMessage
  | ToolMessage
  | CommandMessage
  | CommandResultMessage;

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
        if (!segment.text && !segment.thinking) {
          segment.text = decoded.text;
        }
        if (decoded.usage) {
          segment.usage = decoded.usage;
        }
        break;
      }
      default:
        break;
    }
  }
  return messages;
}
