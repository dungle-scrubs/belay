import {
  type Api,
  type Context,
  isContextOverflow,
  type Model,
  streamSimple,
  type ThinkingLevel,
  type TSchema,
} from "@mariozechner/pi-ai";
import { Effect, Stream } from "effect";
import { debug } from "../log";
import { msg } from "../tools/shared";
import { ProviderUnavailable } from "./errors";
import { buildSystemPrompt } from "./system-prompt";
import type { ChatMessage, ProviderError, ProviderEvent, ToolDef } from "./types";

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
 * Private async generator over the signal-driven request; the public streamPiAi below
 * wraps it as an Effect Stream and owns the AbortController.
 */
async function* piAiEvents<TApi extends Api>(
  model: Model<TApi>,
  messages: readonly ChatMessage[],
  tools: readonly ToolDef[],
  options: {
    readonly apiKey: string;
    readonly contextWindow: number;
    readonly reasoning?: ThinkingLevel;
    readonly signal: AbortSignal;
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
  // signal rides into streamSimple so an interrupt (which aborts it - see streamPiAi)
  // closes the underlying request: upstream cancel where the adapter supports it.
  const streamOptions = {
    apiKey: options.apiKey,
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    signal: options.signal,
  };
  debug("pi-ai", "stream", {
    model: model.id,
    messages: messages.length,
    tools: tools.length,
    reasoning: options.reasoning,
    contextWindow: options.contextWindow,
  });
  for await (const event of streamSimple(model, context, streamOptions)) {
    debug("pi-ai", event.type);
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
      debug("pi-ai", "done", {
        stopReason: event.message?.stopReason,
        input: usage?.input,
        output: usage?.output,
      });
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

/**
 * One model step as an Effect Stream of ProviderEvents. The stream owns an
 * AbortController whose abort is registered as a scoped finalizer, so interrupting the
 * consuming fiber tears the underlying pi-ai/LM Studio request down cleanly (validated:
 * A-004, scripts/spike-a004-interrupt.ts). A thrown stream error becomes a typed
 * ProviderUnavailable in the `E` channel; a clean abort ends the stream without failing.
 */
export function streamPiAi<TApi extends Api>(
  model: Model<TApi>,
  messages: readonly ChatMessage[],
  tools: readonly ToolDef[],
  options: {
    readonly apiKey: string;
    readonly contextWindow: number;
    readonly reasoning?: ThinkingLevel;
    readonly provider: string;
  },
): Stream.Stream<ProviderEvent, ProviderError> {
  return Stream.unwrapScoped(
    Effect.gen(function* () {
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      return Stream.fromAsyncIterable(
        piAiEvents(model, messages, tools, { ...options, signal: controller.signal }),
        (cause) =>
          new ProviderUnavailable({ provider: options.provider, detail: msg(cause), cause }),
      );
    }),
  );
}
