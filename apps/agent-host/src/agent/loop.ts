import type { ChatMessage, Provider, ToolCall, Usage } from "../providers";
import { executeTool, TOOL_DEFS } from "../tools";

const MAX_STEPS = 8;

/** One event from the agent loop: text, thinking, a tool call, usage, or an overflow. */
export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool_start"; readonly call: ToolCall }
  | { readonly type: "tool_end"; readonly call: ToolCall; readonly result: string }
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "overflow"; readonly reason: string };

/**
 * Runs the model<->tools loop: stream a model step; if it requested tools, execute
 * them, append the results, and loop; otherwise the model answered and we stop.
 * Bounded by MAX_STEPS to prevent runaway tool loops.
 */
export async function* runAgent(
  provider: Provider,
  history: readonly ChatMessage[],
  reasoning?: string,
  signal?: AbortSignal,
  runId?: string,
): AsyncIterable<AgentEvent> {
  const conversation: ChatMessage[] = [...history];
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (signal?.aborted) {
      return; // cancelled between steps - do not start another model request
    }
    const toolCalls: ToolCall[] = [];
    let assistantText = "";
    for await (const event of provider.stream(conversation, TOOL_DEFS, reasoning, signal)) {
      if (event.type === "text") {
        assistantText += event.text;
        yield { type: "text", text: event.text };
      } else if (event.type === "thinking") {
        // Thinking is forwarded for display but not fed back as assistant content.
        yield { type: "thinking", text: event.text };
      } else if (event.type === "overflow") {
        yield { type: "overflow", reason: event.reason };
      } else if (event.type === "usage") {
        yield { type: "usage", usage: event.usage };
      } else {
        toolCalls.push(event.call);
      }
    }
    if (signal?.aborted) {
      return; // ESC landed mid-stream: stop before running tools or another step
    }
    if (toolCalls.length === 0) {
      return; // the model answered without calling a tool
    }
    conversation.push({ role: "assistant", content: assistantText, toolCalls });
    for (const call of toolCalls) {
      if (signal?.aborted) {
        return; // cancelled before this tool ran
      }
      yield { type: "tool_start", call };
      const result = await executeTool(call.name, call.arguments, runId);
      yield { type: "tool_end", call, result };
      conversation.push({ role: "tool", content: result, toolCallId: call.id, name: call.name });
    }
  }
}
