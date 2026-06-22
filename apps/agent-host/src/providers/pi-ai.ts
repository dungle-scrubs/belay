import {
  type Api,
  type Context,
  isContextOverflow,
  type Model,
  streamSimple,
  type ThinkingLevel,
  type TSchema,
} from "@mariozechner/pi-ai";
import { buildSystemPrompt } from "./system-prompt";
import type { ChatMessage, ProviderEvent, ToolDef } from "./types";

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Converts the host history to pi-ai messages, preserving tool calls and results:
 * an assistant turn that called tools becomes content blocks (text + toolCall), and
 * a tool turn becomes a toolResult message - so multi-step tool loops round-trip.
 */
export function toPiAiMessages(messages: readonly ChatMessage[]): Context["messages"] {
  return messages.map((message): unknown => {
    if (message.role === "user") {
      return { role: "user", content: message.content, timestamp: Date.now() };
    }
    if (message.role === "tool") {
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.name ?? "",
        content: [{ type: "text", text: message.content }],
        isError: false,
        timestamp: Date.now(),
      };
    }
    const content: unknown[] = [];
    if (message.content) {
      content.push({ type: "text", text: message.content });
    }
    for (const call of message.toolCalls ?? []) {
      content.push({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: parseArgs(call.arguments),
      });
    }
    return {
      role: "assistant",
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      timestamp: Date.now(),
    };
  }) as Context["messages"];
}

/** Converts host tool defs to pi-ai tools (JSON Schema cast to typebox TSchema). */
export function toPiAiTools(tools: readonly ToolDef[]): Context["tools"] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as TSchema,
  }));
}

/**
 * Streams one model step through pi-ai and maps its events onto host ProviderEvents.
 * The caller supplies the model (cloud via getModel, or a hand-built local model),
 * an apiKey, and the effective contextWindow - cloud knows it statically, local
 * adapters learn it from the running model - for the trailing usage event.
 */
export async function* streamPiAi<TApi extends Api>(
  model: Model<TApi>,
  messages: readonly ChatMessage[],
  tools: readonly ToolDef[],
  options: {
    readonly apiKey: string;
    readonly contextWindow: number;
    readonly reasoning?: ThinkingLevel;
  },
): AsyncIterable<ProviderEvent> {
  const context: Context = {
    systemPrompt: buildSystemPrompt(tools),
    messages: toPiAiMessages(messages),
    ...(tools.length > 0 ? { tools: toPiAiTools(tools) } : {}),
  };
  // Time generation from the first GENERATED token (reasoning or visible) to done,
  // so tokens/sec covers the same span the output tokens were produced in. Timing
  // from the first visible token alone undercounts reasoning models (hidden reasoning
  // runs first), and timing the whole request over-penalizes cloud latency.
  const requestAt = Date.now();
  let generationAt = 0;
  const markGeneration = () => {
    if (generationAt === 0) {
      generationAt = Date.now();
    }
  };
  const streamOptions = options.reasoning
    ? { apiKey: options.apiKey, reasoning: options.reasoning }
    : { apiKey: options.apiKey };
  for await (const event of streamSimple(model, context, streamOptions)) {
    if (
      event.type === "text_delta" ||
      event.type === "thinking_start" ||
      event.type === "thinking_delta" ||
      event.type === "toolcall_start"
    ) {
      markGeneration();
    }
    if (event.type === "text_delta") {
      yield { type: "text", text: event.delta };
    } else if (event.type === "thinking_delta") {
      yield { type: "thinking", text: event.delta };
    } else if (event.type === "toolcall_end") {
      yield {
        type: "tool_call",
        call: {
          id: event.toolCall.id,
          name: event.toolCall.name,
          arguments: JSON.stringify(event.toolCall.arguments ?? {}),
        },
      };
    } else if (event.type === "done") {
      // usage is initialized by pi-ai, but guard anyway: a missing one must never
      // crash the turn (that surfaced as a silent empty answer).
      const usage = event.message?.usage;
      yield {
        type: "usage",
        usage: {
          input: usage?.input ?? 0,
          output: usage?.output ?? 0,
          contextWindow: options.contextWindow,
          genMs: Date.now() - (generationAt || requestAt),
        },
      };
      // Overflow = the response was bounded by the context window. A "length" stop
      // only counts when input+output actually fills the window (so a model whose
      // max-output cap is below its window doesn't false-positive on long answers);
      // isContextOverflow adds the prompt-too-large / provider-error variants.
      const used = (usage?.input ?? 0) + (usage?.output ?? 0);
      const hitWall =
        event.message?.stopReason === "length" && used >= options.contextWindow * 0.98;
      if (event.message && (hitWall || isContextOverflow(event.message, options.contextWindow))) {
        yield {
          type: "overflow",
          reason: hitWall
            ? "hit the context window mid-response — output was truncated"
            : "the prompt exceeded the model's context window",
        };
      }
    }
  }
}
