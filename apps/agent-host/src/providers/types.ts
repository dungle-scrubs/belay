/**
 * Responsible for: the shared provider contract - the Provider interface, the DescribableProvider
 * base, and the event/message/tool/readiness/capability types every adapter speaks.
 */
import type { ArtifactRef, PastePayload, ProviderModel, Usage } from "@trevor/session";
import type { Effect, Stream } from "effect";
import type { LocalModelTarget } from "../admission/contract";
import type { ProviderAuthError, ProviderUnavailable } from "./errors";

// Wire types owned in @trevor/session, re-exported so importers can reach them through the
// providers barrel: `Usage` (the host's per-step usage and the serialized turn usage are the
// same shape, so they share one declaration - D-005) and `ProviderModel` (the per-provider
// descriptor the host announces in host.online).
export type { ProviderModel, Usage };

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
 * The model-step events that pass through the host unchanged: assistant text,
 * reasoning ("thinking") text, token usage, and an overflow signal. Thinking is the
 * model's reasoning trace - kept on its own channel so callers can render or hide it
 * without polluting the answer. These four are shared verbatim with the agent loop's
 * `AgentEvent` (agent/loop.ts), so the loop forwards them rather than re-declaring them.
 */
export type ModelEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "overflow"; readonly reason: string };

/**
 * One streamed event from a provider: the shared model-step events plus a tool call.
 * The tool call is provider-only - the agent loop turns it into tool_start/tool_end as
 * it executes; the other four flow through to the loop's `AgentEvent` unchanged.
 */
export type ProviderEvent = ModelEvent | { readonly type: "tool_call"; readonly call: ToolCall };

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
  readonly pastes?: readonly PastePayload[]; // user turn: exact payloads for [Pasted text #N] tokens
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
  /** Where the model runs: "local" (on this machine) or "cloud" (a remote API). */
  readonly kind: "local" | "cloud";
  /**
   * This provider's wire descriptor for the host.online announcement: label, model id,
   * reasoning options, and kind. Implemented once (DescribableProvider) from the fields
   * above, so a new ProviderModel field is a type error here, not a silent omission.
   */
  describe(): ProviderModel;
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
  /**
   * The local-model residency target this provider keeps resident (plan 11.1), or undefined for a
   * cloud provider that loads nothing. The host reconciles residency claims + eviction off this when
   * a turn resolves its provider, so a local model is claimed while selected and evicted once orphaned.
   */
  residencyTarget?(): LocalModelTarget;
}

/**
 * Base for the concrete providers: implements `describe()` once from the four roster
 * fields each adapter already declares (label/model/reasoning), so the host.online
 * descriptor can't drift from the interface and adding a ProviderModel field surfaces
 * as a compile error here rather than a silent omission. Adapters extend this and supply
 * the streaming/readiness behavior.
 */
export abstract class DescribableProvider implements Provider {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly model: string;
  abstract readonly reasoningLevels: readonly string[];
  abstract readonly defaultReasoning: string;
  abstract readonly kind: "local" | "cloud";

  describe(): ProviderModel {
    return {
      label: this.label,
      model: this.model,
      reasoningLevels: this.reasoningLevels,
      defaultReasoning: this.defaultReasoning,
      kind: this.kind,
    };
  }

  abstract readiness(): Effect.Effect<Readiness>;
  abstract capabilities(): Effect.Effect<ModelCapabilities>;
  abstract warm(): Effect.Effect<void>;
  abstract stream(
    messages: readonly ChatMessage[],
    tools: readonly ToolDef[],
    reasoning?: string,
  ): Stream.Stream<ProviderEvent, ProviderError>;
  // `debugInfo` stays optional on the Provider interface; an adapter that exposes it
  // (e.g. LmStudioProvider) declares it directly without an override, since the base
  // doesn't.
}
