import type { ArtifactRef, Usage } from "@trevor/session";
import type { Effect, Stream } from "effect";
import type { ProviderAuthError, ProviderUnavailable } from "./errors";

// `Usage` is the wire type, owned in @trevor/session (the host's per-step usage and the
// serialized turn usage are the same shape, so they share one declaration - D-005).
export type { Usage };

/** What a provider's stream can fail with, in the Effect `E` channel. */
export type ProviderError = ProviderUnavailable | ProviderAuthError;

/** Model load state for a provider: reachable, and warm (loaded) vs cold. */
export interface Readiness {
  readonly ready: boolean;
  readonly warm: boolean;
}

/**
 * What the current model can do, detected from the provider's source of truth - LM Studio's
 * native model `type`/`capabilities`, or the pi-ai model registry - never hardcoded. Probed
 * (not a static field) because a local provider learns it from whichever model is loaded,
 * which changes at runtime.
 */
export interface ModelCapabilities {
  /** Accepts image input (vision). */
  readonly images: boolean;
  /** Supports tool / function calling. */
  readonly tools: boolean;
  /** The model's native max context length in tokens (its capability, NOT what it is
   *  loaded at); 0 when unknown. The 16k minimum-to-run guard checks this. */
  readonly contextLength: number;
}

/** A tool exposed to the model (OpenAI-style JSON-schema parameters). */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** A tool call the model requested (arguments are a raw JSON string). */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/**
 * One streamed event from a provider: assistant text, reasoning ("thinking") text,
 * a tool call, or token usage. Thinking is the model's reasoning trace - kept on its
 * own channel so callers can render or hide it without polluting the answer.
 */
export type ProviderEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool_call"; readonly call: ToolCall }
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "overflow"; readonly reason: string };

/** An image resolved from a blob-store artifact to inline base64, for a vision provider. */
export interface ChatImage {
  readonly hash: string;
  readonly mimeType: string;
  readonly data: string;
}

/** One message in the conversation (user, assistant, or a tool result). */
export interface ChatMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[]; // assistant turn that requested tools
  readonly toolCallId?: string; // tool result: the call it answers
  readonly name?: string; // tool result: the tool name
  readonly artifacts?: readonly ArtifactRef[]; // user turn: content-addressed attachments
  readonly images?: readonly ChatImage[]; // user turn: image artifacts resolved to base64
}

/**
 * A model provider the host streams completions from. Readiness is per-adapter
 * (local providers report real load state; cloud is always warm). stream() runs
 * one model step over the conversation, emitting text, thinking, and any tool calls.
 *
 * `reasoningLevels` advertises the model's available thinking options, lowest to
 * highest, for the UI to surface - which can be:
 *   - non-existent (`[]`)            the model has no thinking; no control is shown
 *   - binary       (`["off","on"]`)  on/off thinking (e.g. local qwen enable_thinking)
 *   - graduated    (`["minimal",…]`) effort levels (e.g. GPT-5.x; "off" if disableable)
 * The `reasoning` arg to stream() is one of those values; "off"/absent means none.
 */
export interface Provider {
  readonly id: string;
  /** Human-friendly name for the UI selector (e.g. "Qwen (local)"). */
  readonly label: string;
  readonly model: string;
  readonly reasoningLevels: readonly string[];
  readonly defaultReasoning: string;
  readiness(): Effect.Effect<Readiness>;
  /** Detects what the current model can do (vision, tools), from the provider's own source. */
  capabilities(): Effect.Effect<ModelCapabilities>;
  warm(): Effect.Effect<void>;
  /**
   * One model step as a Stream of events. Cancellation is fiber interruption - the
   * stream's scope tears the underlying request down (no signal arg); a stream failure
   * rides the typed ProviderError channel.
   */
  stream(
    messages: readonly ChatMessage[],
    tools: readonly ToolDef[],
    reasoning?: string,
  ): Stream.Stream<ProviderEvent, ProviderError>;
  /**
   * Optional inspectable internal state for /doctor: load/context details, last error,
   * whatever the adapter hides that an operator would otherwise have to read source for.
   */
  debugInfo?(): Record<string, unknown>;
}
