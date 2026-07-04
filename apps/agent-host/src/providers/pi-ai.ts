/**
 * Responsible for: the pi-ai stream adapter - projecting host messages/tools into pi-ai context
 * and mapping stream events onto ProviderEvents.
 * Not for: failure normalization at the boundary (failure-normalizer.ts), the classification rules
 * (failure-taxonomy.ts / error-classifier.ts), or reasoning-effort policy (reasoning-policy.ts).
 */
import {
  type Api,
  type Context,
  type Model,
  stream,
  type ThinkingLevel,
  type TSchema,
} from "@earendil-works/pi-ai/compat";
import { activeStyleGuidance } from "@host/prefs/style-store";
import { debug } from "@host/transport/log";
import {
  type PastePayload,
  parseImageTokens,
  parsePasteTokens,
  stripImageTokens,
} from "@trevor/session";
import { Effect, Stream } from "effect";
import {
  classifyResponseOverflow,
  isAuthFailure,
  isContextOverflow,
  parseOverflowWindow,
  promptTooBig,
} from "./error-classifier";
import { ProviderAuthError } from "./errors";
import { normalizeProviderFailure } from "./failure-normalizer";
import { generationTimer } from "./generation-timer";
import { reasoningStreamFields } from "./reasoning-policy";
import { buildSystemPrompt, promptOverheadChars } from "./system-prompt";
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

const textBlock = (text: string): TextBlock => ({ type: "text", text });
const imageBlock = (img: { data: string; mimeType: string }): ImageBlock => ({
  type: "image",
  data: img.data,
  mimeType: img.mimeType,
});

/**
 * Expands `[Pasted text #N +M lines]` tokens into their exact payloads at the token position, in
 * reading order (10-large-paste-placeholders): the k-th token becomes the k-th payload's text, so the
 * model receives the full pasted content where the user placed it - never the compact placeholder. A
 * token with no paired payload (a legacy / restored message) drops to empty rather than leaking the
 * placeholder. Runs BEFORE image projection (escape hatch #2) so image interleaving sees ordinary
 * text. <!-- D-002 -->
 */
function expandPasteTokens(content: string, pastes: readonly PastePayload[]): string {
  const tokens = parsePasteTokens(content);
  if (tokens.length === 0) {
    return content;
  }
  let out = "";
  let last = 0;
  tokens.forEach((token, k) => {
    out += content.slice(last, token.start) + (pastes[k]?.text ?? "");
    last = token.end;
  });
  return out + content.slice(last);
}

/** The `[attachments: ...]` note for artifacts not sent as image blocks (or "" when none). */
function attachmentsNote(
  refs: readonly { readonly name?: string; readonly kind: string }[],
): string {
  return refs.length ? `[attachments: ${refs.map((a) => a.name ?? a.kind).join(", ")}]` : "";
}

/**
 * Builds a pi-ai user content value (D-028 / D-092). When the message text carries `[Image #N]`
 * tokens, they are stripped and the inlined images are interleaved AT the token positions (so the
 * model sees text/image order matching reading order, never literal token clutter). The k-th token
 * maps to the k-th IMAGE artifact (documents are never tokened). When the model can't see images
 * (non-vision, undecodable) the content collapses to clean token-stripped text plus an attachments
 * note. A legacy message with no tokens keeps the old shape: text + note, with images appended.
 */
function userContent(message: ChatMessage): string | (TextBlock | ImageBlock)[] {
  // Expand pasted-text tokens into their exact payloads FIRST, so the rest of the projection (image
  // interleaving, the no-token path) operates on ordinary text and never sees a paste placeholder.
  const content = expandPasteTokens(message.content, message.pastes ?? []);
  const images = message.images ?? [];
  const imageByHash = new Map(images.map((img) => [img.hash, img] as const));
  const artifacts = message.artifacts ?? [];
  const inlined = new Set(images.map((i) => i.hash));
  // Documents + any image the host couldn't inline (non-vision, undecodable, HEIC) ride as a note.
  const noted = artifacts.filter((a) => !inlined.has(a.hash));
  const tokens = parseImageTokens(content);

  if (tokens.length === 0) {
    // Legacy / no-token path: text (+ note) as before, images appended after.
    const note = noted.length ? `\n\n${attachmentsNote(noted)}` : "";
    const text = `${content}${note}`;
    if (images.length === 0) {
      return text;
    }
    return [...(text ? [textBlock(text)] : []), ...images.map(imageBlock)];
  }

  // Tokened path: interleave each token's image at its position, mapping token #k -> k-th image
  // artifact -> its inlined block.
  const imageArtifacts = artifacts.filter((a) => a.kind === "image");
  const blocks: (TextBlock | ImageBlock)[] = [];
  let last = 0;
  tokens.forEach((token, k) => {
    const pre = content.slice(last, token.start);
    if (pre) {
      blocks.push(textBlock(pre));
    }
    const ref = imageArtifacts[k];
    const img = ref ? imageByHash.get(ref.hash) : undefined;
    if (img) {
      blocks.push(imageBlock(img));
    }
    last = token.end;
  });
  const tail = content.slice(last);
  if (tail) {
    blocks.push(textBlock(tail));
  }
  if (noted.length) {
    blocks.push(textBlock(`\n\n${attachmentsNote(noted)}`));
  }

  // No image actually inlined (non-vision, or every image failed): the model gets a clean string,
  // tokens stripped, never literal [Image #N] clutter.
  if (!blocks.some((block) => block.type === "image")) {
    const note = noted.length ? `\n\n${attachmentsNote(noted)}` : "";
    return `${stripImageTokens(content)}${note}`.trim();
  }

  return blocks;
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
      // A tool result may carry inlined frame images (video_inspect, D-003): the serialized text
      // plus up to a capped set of frame images, so a vision model can SEE the sampled frames. A
      // non-vision turn never resolves them, so `images` is empty and this is the old text-only shape.
      const images = message.images ?? [];
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.name ?? "",
        content: [{ type: "text", text: message.content }, ...images.map(imageBlock)],
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
    (promptOverheadChars(context.systemPrompt, tools) +
      messages.reduce(
        (sum, m) =>
          sum +
          m.content.length +
          // A pasted-text token's content is a compact placeholder, but the model receives the full
          // expanded payload - count it so a large paste is reflected in the overflow estimate.
          (m.pastes?.reduce((a, p) => a + p.text.length, 0) ?? 0) +
          (m.toolCalls?.reduce((a, c) => a + c.arguments.length, 0) ?? 0),
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
  // Time generation from the first GENERATED token (reasoning or visible) to done; the shared
  // timer owns the measurement rationale (generation-timer.ts).
  const timer = generationTimer();
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
      timer.mark();
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
      // Some providers report cached/billable input here, which can be lower than the full prompt
      // context. Budgeting and the ctx meter need the full prompt floor.
      const usage = event.message?.usage;
      const input = Math.max(usage?.input ?? 0, promptTokensEst);
      debug("pi-ai", "done", {
        stopReason: event.message?.stopReason,
        input: usage?.input,
        inputFloor: input,
        output: usage?.output,
      });
      yield {
        type: "usage",
        usage: {
          input,
          output: usage?.output ?? 0,
          contextWindow: options.contextWindow,
          genMs: timer.genMs(),
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
      if (isContextOverflow(detail)) {
        // The provider's native rejection can reveal a SMALLER real window than the one we sent (a
        // stale bundled value); carry that real `N` in the reason so the host's self-heal (03.2 M3)
        // learns reality, not the number we already had. LM Studio's message omits sizes, so its
        // window parses to null and the reason keeps the window we sent, exactly as before.
        const nativeWindow = parseOverflowWindow(detail);
        const realWindow =
          nativeWindow !== null && nativeWindow < options.contextWindow
            ? nativeWindow
            : options.contextWindow;
        yield {
          type: "overflow",
          reason: promptTooBig(promptTokensEst, realWindow),
        };
        return;
      }
      // A refused credential is an auth failure, not an outage: surface it as such so the
      // UI tells the user to re-auth rather than "provider unavailable".
      if (isAuthFailure(detail)) {
        throw new ProviderAuthError({ provider: options.provider, detail });
      }
      // Preserve the structured error object as the thrown cause (02.15) so the boundary's evidence
      // extraction + cause-chain detail can mine a nested code/`.cause` it carries (e.g. a syscall
      // ECONNRESET); the existing classification reads message + code either way.
      throw new Error(detail, { cause: event.error });
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
    /** Whether this provider is a local runtime (LM Studio): refines how a connection refusal
     *  classifies in the failure taxonomy (D-076 M2). Defaults to false (cloud). */
    readonly local?: boolean;
    /** Whether this provider is a gateway/catalog source proxying upstream model providers: turns on
     *  gateway-vs-upstream origin attribution on a failure (D-076 M2). Defaults to false. */
    readonly gateway?: boolean;
  },
): Stream.Stream<ProviderEvent, ProviderError> {
  const { messages, tools, provider, systemPrompt, local, gateway, ...streamOptions } = options;
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
          systemPrompt:
            systemPrompt ?? buildSystemPrompt(tools, { styleGuidance: activeStyleGuidance() }),
        }),
        // The shared boundary normalizer (failure-normalizer.ts): a classified auth failure rides
        // through as-is; anything else is normalized into the failure taxonomy -> ProviderUnavailable
        // with class/userAction/evidence and `retryable` derived from the class (D-076/D-077).
        (cause) => normalizeProviderFailure({ provider, cause, local, gateway }),
      );
    }),
  );
}
