import {
  type Api,
  type Context,
  type Model,
  stream,
  type ThinkingLevel,
  type TSchema,
} from "@earendil-works/pi-ai/compat";
import { Effect, Stream } from "effect";
import { debug } from "../log";
import { msg } from "../messages";
import {
  classifyResponseOverflow,
  isAuthError,
  isContextLengthError,
  isRetryableOutage,
  promptTooBig,
} from "./error-classifier";
import { ProviderAuthError, ProviderUnavailable } from "./errors";
import { reasoningStreamFields } from "./reasoning-policy";
import { buildSystemPrompt } from "./system-prompt";
import type { ChatMessage, ProviderError, ProviderEvent, ToolDef } from "./types";

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };

/**
 * Builds a pi-ai user content value: a plain string when there are no resolved images,
 * or a [text, ...image] block array when the message carries them (D-028). Artifacts that
 * are NOT shown as images (documents, or images when the model can't see them) are
 * surfaced as a short text note so the model at least knows they were attached.
 */
function userContent(message: ChatMessage): string | (TextBlock | ImageBlock)[] {
  const images = message.images ?? [];
  // Note exactly the artifacts that were NOT inlined (documents, plus any image the host
  // couldn't inline - HEIC, undecodable), so the model still knows they were attached.
  const inlined = new Set(images.map((i) => i.hash));
  const noted = (message.artifacts ?? []).filter((a) => !inlined.has(a.hash));
  const note = noted.length
    ? `\n\n[attachments: ${noted.map((a) => a.name ?? a.kind).join(", ")}]`
    : "";
  const text = `${message.content}${note}`;
  if (images.length === 0) {
    return text;
  }
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
  ];
}

/**
 * Converts the host history to pi-ai messages, preserving tool calls and results:
 * an assistant turn that called tools becomes content blocks (text + toolCall), and
 * a tool turn becomes a toolResult message - so multi-step tool loops round-trip.
 */
export function toPiAiMessages(messages: readonly ChatMessage[]): Context["messages"] {
  return messages.map((message): unknown => {
    if (message.role === "user") {
      return { role: "user", content: userContent(message), timestamp: Date.now() };
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
 * Private async generator over the signal-driven request; the public streamPiAiModel
 * below wraps it as an Effect Stream and owns the AbortController.
 */
async function* piAiEvents<TApi extends Api>(
  model: Model<TApi>,
  messages: readonly ChatMessage[],
  tools: readonly ToolDef[],
  options: {
    readonly apiKey: string;
    readonly contextWindow: number;
    readonly reasoning?: ThinkingLevel;
    readonly provider: string;
    readonly signal: AbortSignal;
    /** The system prompt, built upstream (streamPiAiModel) so this adapter just consumes it. */
    readonly systemPrompt: string;
  },
): AsyncIterable<ProviderEvent> {
  const context: Context = {
    systemPrompt: options.systemPrompt,
    messages: toPiAiMessages(messages),
    ...(tools.length > 0 ? { tools: toPiAiTools(tools) } : {}),
  };
  // Rough prompt-token estimate (chars/4) for the overflow message - LM Studio's
  // context-length error omits the sizes, so we attach our own.
  const promptTokensEst = Math.round(
    ((context.systemPrompt?.length ?? 0) +
      JSON.stringify(tools).length +
      messages.reduce(
        (sum, m) =>
          sum + m.content.length + (m.toolCalls?.reduce((a, c) => a + c.arguments.length, 0) ?? 0),
        0,
      )) /
      4,
  );
  // LM Studio's default context policy SILENTLY TRUNCATES an over-window prompt (rolling
  // window: it drops the oldest messages to fit) instead of erroring - so an oversized
  // prompt never surfaces as a 400, the loop never sees overflow, and the model loses the
  // early context (it re-reads and loops). Don't trust the provider to complain: detect it
  // from our own estimate. When the prompt alone exceeds the window, emit overflow so the
  // loop trims a tool result and retries - or, when nothing is left to trim, surfaces the
  // size. This fires BEFORE the request, so recovery uses the input lever (trim), not output.
  if (promptTokensEst >= options.contextWindow) {
    yield {
      type: "overflow",
      reason: promptTooBig(promptTokensEst, options.contextWindow),
    };
    return;
  }
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
  // signal rides into stream() so an interrupt (which aborts it - see streamPiAiModel)
  // closes the underlying request: upstream cancel where the adapter supports it. The reasoning
  // fields (effort, or nothing) come from the policy seam - it owns the omit too (see its doc).
  const reasoningFields = reasoningStreamFields(model, options.reasoning);
  const streamOptions = {
    apiKey: options.apiKey,
    ...reasoningFields,
    signal: options.signal,
  };
  debug("pi-ai", "stream", {
    model: model.id,
    messages: messages.length,
    tools: tools.length,
    reasoning: options.reasoning,
    reasoningEffort: reasoningFields.reasoningEffort,
    contextWindow: options.contextWindow,
  });
  for await (const event of stream(model, context, streamOptions)) {
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
      // Did the finished response overflow the window? The classifier owns the decision
      // (a window-filling "length" stop, or pi-ai's prompt-too-large variants) and the wording.
      const overflowReason = classifyResponseOverflow(event.message, options.contextWindow);
      if (overflowReason) {
        yield { type: "overflow", reason: overflowReason };
      }
    } else if (event.type === "error") {
      // A clean interrupt (cancel/ESC) ends the stream quietly; the fiber interrupt
      // propagates on its own.
      if (event.reason === "aborted") {
        return;
      }
      // LM Studio rejects a prompt larger than the loaded window with a context-length
      // 400. It was being swallowed (unhandled `error` event), so a too-big prompt looked
      // like an empty turn. Surface it as overflow so the loop trims & retries when there
      // are tool results, or surfaces a clear too-small-window message when there aren't -
      // LM Studio's message omits the sizes, so we attach the estimate and the window.
      const detail = event.error.errorMessage ?? "provider stream error";
      if (isContextLengthError(detail)) {
        yield {
          type: "overflow",
          reason: promptTooBig(promptTokensEst, options.contextWindow),
        };
        return;
      }
      // A refused credential is an auth failure, not an outage: surface it as such so the
      // UI tells the user to re-auth rather than "provider unavailable".
      if (isAuthError(detail)) {
        throw new ProviderAuthError({ provider: options.provider, detail });
      }
      throw new Error(detail);
    }
  }
}

/**
 * One model step as an Effect Stream of ProviderEvents - the single entry both adapters
 * use. It owns all the shared plumbing: it resolves the adapter's `buildModel` Effect
 * (the only thing that differs - LM Studio sizes a local model against the served window,
 * Codex resolves its OAuth key and looks up the registry model), then runs that model
 * through pi-ai under an AbortController whose abort is registered as a scoped finalizer,
 * so interrupting the consuming fiber tears the underlying pi-ai/LM Studio request down
 * cleanly (validated: A-004, the hermetic interrupt test in test/turn.test.ts). A `buildModel` failure or a
 * thrown stream error rides the typed ProviderError `E` channel; a clean abort ends the
 * stream without failing.
 */
export function streamPiAiModel<TApi extends Api>(
  buildModel: Effect.Effect<Model<TApi>, ProviderError>,
  options: {
    readonly messages: readonly ChatMessage[];
    readonly tools: readonly ToolDef[];
    readonly apiKey: string;
    readonly contextWindow: number;
    readonly reasoning?: ThinkingLevel;
    readonly provider: string;
    /** The turn's system prompt. Defaults to the one derived from `tools`; passing it lets the
     *  turn-runner build it once. Either way piAiEvents just consumes it (it owns no prompt policy). */
    readonly systemPrompt?: string;
  },
): Stream.Stream<ProviderEvent, ProviderError> {
  const { messages, tools, provider, systemPrompt, ...streamOptions } = options;
  return Stream.unwrapScoped(
    Effect.gen(function* () {
      const model = yield* buildModel;
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      return Stream.fromAsyncIterable(
        piAiEvents(model, messages, tools, {
          ...streamOptions,
          provider,
          signal: controller.signal,
          systemPrompt: systemPrompt ?? buildSystemPrompt(tools),
        }),
        // A classified auth failure (see error-classifier) rides through as-is; anything else is
        // an outage -> ProviderUnavailable, tagged retryable when the text is a transient transport
        // fault so the loop can auto-reconnect before any token streams (D-076…D-078).
        (cause) =>
          cause instanceof ProviderAuthError
            ? cause
            : new ProviderUnavailable({
                provider,
                detail: msg(cause),
                cause,
                retryable: isRetryableOutage(msg(cause)),
              }),
      );
    }),
  );
}
