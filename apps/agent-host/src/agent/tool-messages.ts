import type { ChatMessage, ToolCall } from "../providers";

/**
 * The one rule for turning a stream of tool.started/tool.completed events into prompt messages,
 * shared by BOTH the prompt projection (history-projection.ts) and the compaction planner
 * (compactor.ts) so a turn's folded size always matches its real prompt footprint - they cannot
 * drift. Within a step the loop emits all of the step's tool.started (call order, D-050) then their
 * tool.completed, so a contiguous run of starts is one step's calls: it becomes one
 * `{role:"assistant", toolCalls}` message, and the completions that follow are its `{role:"tool"}`
 * results. The next start (after results) begins a fresh group.
 *
 * `emit` receives each produced message (the caller pushes it into whatever array it is building, so
 * the same grouper drives a flat cross-turn projection or a per-turn decomposition). `reset` marks a
 * turn boundary (a user.message or assistant.completed). `canEmitAssistant` lets the projection
 * refuse a leading tool-call message before any user turn (the prompt must open on a user message).
 */
export function toolCallGrouper(emit: (message: ChatMessage) => void) {
  let pending: ToolCall[] = [];
  let emitted = false;
  return {
    reset(): void {
      pending = [];
      emitted = false;
    },
    started(callId: string, name: string, args: string): void {
      if (emitted) {
        // A fresh step's calls begin after the prior group's results were emitted.
        pending = [];
        emitted = false;
      }
      pending.push({ id: callId, name, arguments: args });
    },
    completed(callId: string, name: string, result: string, canEmitAssistant = true): void {
      // The first completion flushes the assistant tool-call message ahead of its results, so every
      // tool result follows an assistant message declaring its call id (as providers require).
      if (pending.length > 0 && !emitted && canEmitAssistant) {
        emit({ role: "assistant", content: "", toolCalls: pending });
        emitted = true;
      }
      if (emitted) {
        emit({ role: "tool", content: result, toolCallId: callId, name });
      }
    },
  };
}
