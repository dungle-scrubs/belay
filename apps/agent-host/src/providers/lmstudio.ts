/**
 * Responsible for: the LM Studio Provider adapter - the env-resolving factory and the
 * admission-gated Effect/Provider shim over LmStudioClient.
 * Not for: the load lifecycle and context reloads; those live in lmstudio-client.ts.
 */
import { envNumber } from "@host/boot/env";
import { DEFAULT_LMSTUDIO_URL } from "@trevor/session";
import { Effect, FiberRef, Stream } from "effect";
import type { LocalModelTarget } from "../admission/contract";
import { admittedStream } from "../admission/effect";
import type { LocalAdmissionGate } from "../admission/service";
import { AdmissionTurnRef } from "../admission/turn-ref";
import type { ResidencyRecorder } from "../residency/registry";
import { LmStudioClient } from "./lmstudio-client";
import { streamPiAiModel } from "./pi-ai";
import {
  type ChatMessage,
  DescribableProvider,
  type ModelCapabilities,
  type ProviderError,
  type ProviderEvent,
  type Readiness,
  type ToolDef,
} from "./types";

/** Explicit, fully-resolved config for the LM Studio provider - the factory below reads the
 *  LMSTUDIO_* / LMS_BIN env into this, so neither the provider nor its client touches process.env. */
export interface LmStudioConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1 */
  readonly url: string;
  readonly model: string;
  /** Human-friendly name for the UI selector. */
  readonly label: string;
  /** Upper bound on the context to load at (tokens); Infinity = the model's own max. */
  readonly contextCap: number;
  /** Image support: true/false forces it, null = auto-detect from the model type. */
  readonly visionOverride: boolean | null;
  /** LM Studio's CLI binary. */
  readonly lmsBin: string;
  /** The host's local-admission gate (plan 11), or undefined to run without admission (cloud parity /
   *  tests). When set, generation streams hold a per-model lease and reloads hold the endpoint lease. */
  readonly admissionGate?: LocalAdmissionGate;
  /** Records this slot's `lms load`/unload into the host residency registry (plan 11.1), so only models
   *  THIS instance loaded are eviction-eligible. Omitted = residency tracking disabled (tests). */
  readonly residency?: ResidencyRecorder;
}

/**
 * The default context (tokens) a local model loads at when neither a per-slot `maxContext` nor
 * `LMSTUDIO_MAX_CONTEXT` is set (plan 11.1 D-005). A bounded default rather than the model's native
 * ceiling (e.g. qwen3.6's 256k) because the load context sizes the KV cache, and a too-large window is a
 * direct unified-memory/GPU pressure that contributed to a stalled local turn. Every local slot caps
 * here CONSISTENTLY (the 8-bit and 4-bit qwen slots no longer differ by accident); target compaction
 * keeps the prompt under the window, and a slot that genuinely needs more raises its own `maxContext`.
 */
export const DEFAULT_LOCAL_CONTEXT_CAP = 65_536;

/** The LM Studio CLI binary (`lms`), overridable via LMS_BIN. Resolved here so the provider factory and
 *  the host-level residency unload agree on the binary rather than each re-reading the env. */
export function lmsBin(): string {
  return process.env.LMS_BIN ?? "lms";
}

/** Reads the LMSTUDIO_VISION override into a tri-state: true/false force image support, null
 *  auto-detects from the loaded model type. */
function visionOverride(value: string | undefined): boolean | null {
  return value === "1" || value === "true"
    ? true
    : value === "0" || value === "false"
      ? false
      : null;
}

/**
 * Builds an LM Studio provider for one roster slot, resolving the shared LMSTUDIO_* / LMS_BIN
 * environment here (with the provider, not the registry) into the explicit config its client takes.
 * The caller supplies the slot's model id, label, and optional per-model context cap; everything env
 * lives in this factory, so registering the provider in buildProviders is one line.
 */
export function lmStudioProvider(opts: {
  readonly model: string;
  readonly label: string;
  /** Pins this model's load below the {@link DEFAULT_LOCAL_CONTEXT_CAP} default; takes precedence over
   *  LMSTUDIO_MAX_CONTEXT. */
  readonly maxContext?: number;
  /** The host's local-admission gate; omitted in tests / when admission is disabled. */
  readonly admissionGate?: LocalAdmissionGate;
  /** The host residency registry to record this slot's loads into (plan 11.1); omitted in tests. */
  readonly residency?: ResidencyRecorder;
}): LmStudioProvider {
  return new LmStudioProvider({
    url: process.env.LMSTUDIO_URL ?? DEFAULT_LMSTUDIO_URL,
    model: opts.model,
    label: opts.label,
    // Cap precedence: explicit per-slot maxContext, else LMSTUDIO_MAX_CONTEXT, else the bounded default
    // (so every local slot is capped consistently, not left at the model's native ceiling).
    contextCap: opts.maxContext ?? envNumber("LMSTUDIO_MAX_CONTEXT", DEFAULT_LOCAL_CONTEXT_CAP),
    visionOverride: visionOverride(process.env.LMSTUDIO_VISION),
    lmsBin: lmsBin(),
    admissionGate: opts.admissionGate,
    residency: opts.residency,
  });
}

/**
 * Local LM Studio provider: the Provider interface shim over an LmStudioClient. Streaming and tool
 * calling go through pi-ai's openai-completions adapter (LM Studio speaks the OpenAI chat API); the
 * load lifecycle, model-info learning, and the real context window all live in the client. This
 * class only adapts that to the Effect/Provider contract (readiness/capabilities/warm/stream/
 * debugInfo) and carries the static descriptor fields (id, kind, reasoning levels).
 */
export class LmStudioProvider extends DescribableProvider {
  readonly id = "lmstudio";
  readonly kind = "local" as const;
  readonly label: string;
  readonly model: string;
  /** Local qwen thinking is binary (enable_thinking on/off); "off" = no reasoning. */
  readonly reasoningLevels = ["off", "on"] as const;
  readonly defaultReasoning = "off";
  private readonly client: LmStudioClient;
  /** The OpenAI-compatible base URL (the endpoint identity for admission resource keys). */
  private readonly url: string;
  /** The host's admission gate, or undefined when admission is disabled. */
  private readonly gate?: LocalAdmissionGate;

  constructor(config: LmStudioConfig) {
    super();
    this.model = config.model;
    this.label = config.label;
    this.url = config.url;
    const gate = config.admissionGate;
    this.gate = gate;
    this.client = new LmStudioClient({
      url: config.url,
      model: config.model,
      contextCap: config.contextCap,
      visionOverride: config.visionOverride,
      lmsBin: config.lmsBin,
      providerId: this.id,
      // Serialize `lms load`/`unload` across processes under the endpoint lifecycle lease (M5).
      withLifecycleLease: gate
        ? (fn) =>
            gate.withLifecycle({ provider: this.id, baseUrl: config.url, model: config.model }, fn)
        : undefined,
      residency: config.residency,
    });
  }

  /** This slot's residency target (plan 11.1): the endpoint + model the host claims + evicts against. */
  residencyTarget(): LocalModelTarget {
    return { provider: this.id, baseUrl: this.url, model: this.model };
  }

  readiness(): Effect.Effect<Readiness> {
    return Effect.promise(() => this.client.probe());
  }

  capabilities(): Effect.Effect<ModelCapabilities> {
    return Effect.promise(() => this.client.capabilities());
  }

  /** Pre-load the model at its max context so the first turn doesn't pay for it. */
  warm(): Effect.Effect<void> {
    return Effect.promise(() => this.client.ensureMaxContext()).pipe(Effect.asVoid);
  }

  /** Load/context state for /doctor (delegated to the client, which owns it). */
  debugInfo(): Record<string, unknown> {
    return this.client.debugInfo();
  }

  stream(
    messages: readonly ChatMessage[],
    tools: readonly ToolDef[],
    reasoning?: string,
  ): Stream.Stream<ProviderEvent, ProviderError> {
    const inner = () => this.streamModel(messages, tools, reasoning);
    const gate = this.gate;
    // Generation admission (M6): hold a per-model lease for the whole stream so two local streams for
    // the same LM Studio resource serialize by default (D-003); released when the stream scope closes
    // (completion / failure / cancellation). Without a gate the stream runs unwrapped (cloud parity).
    if (!gate) {
      return inner();
    }
    const target = { provider: this.id, baseUrl: this.url, model: this.model };
    // Read the per-turn reporter off the fiber (set by publishTurn): it carries the run's priority +
    // attribution and the status emitter, so a queued turn surfaces "waiting for LM Studio" attributed
    // to the right run (M7). The acquire's AbortSignal is wired to interruption, so cancelling a queued
    // turn frees its lease.
    const acquire = FiberRef.get(AdmissionTurnRef).pipe(
      Effect.flatMap((turn) =>
        Effect.promise((signal) =>
          gate.acquireGeneration(target, {
            signal,
            ...(turn ? { context: turn.context, onStatus: turn.onStatus } : {}),
          }),
        ),
      ),
    );
    return admittedStream(acquire, inner);
  }

  /** The raw model stream (no admission): unwrap the best-effort context reload, then stream pi-ai. */
  private streamModel(
    messages: readonly ChatMessage[],
    tools: readonly ToolDef[],
    reasoning?: string,
  ): Stream.Stream<ProviderEvent, ProviderError> {
    // ensureMaxContext is async (and best-effort, never fails), so unwrap it into the stream; the
    // model is built against the context LM Studio actually serves, and the same served window
    // feeds the stream options.
    return Stream.unwrap(
      Effect.promise(() => this.client.ensureMaxContext()).pipe(
        Effect.map((contextWindow) => {
          // qwen is binary. The qwen thinking format sends `enable_thinking` derived from the
          // reasoning level: "off" -> enable_thinking:false (qwen thinks by default otherwise),
          // anything else -> enable_thinking:true. With model.reasoning + the qwen format, omitting
          // the level (undefined) sends false; "high" sends true. "off" isn't a pi-ai ThinkingLevel.
          const thinking = reasoning !== undefined && reasoning !== "off";
          return streamPiAiModel(Effect.succeed(this.client.buildModel(contextWindow)), {
            messages,
            tools,
            // LM Studio ignores the key, but pi-ai requires a non-empty one.
            apiKey: "lm-studio",
            contextWindow,
            reasoning: thinking ? "high" : undefined,
            provider: this.id,
            // A local runtime: a connection refusal classifies as "runtime not running" (actionable),
            // not a retryable transport fault (D-076 M2).
            local: true,
          });
        }),
      ),
    );
  }
}
