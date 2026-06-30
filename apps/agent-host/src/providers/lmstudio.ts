import { DEFAULT_LMSTUDIO_URL } from "@trevor/session";
import { Effect, Stream } from "effect";
import { admittedStream } from "../admission/effect";
import type { LocalAdmissionGate } from "../admission/service";
import { envNumber } from "../env";
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
  /** Pins this model's load below its native ceiling; takes precedence over LMSTUDIO_MAX_CONTEXT. */
  readonly maxContext?: number;
  /** The host's local-admission gate; omitted in tests / when admission is disabled. */
  readonly admissionGate?: LocalAdmissionGate;
}): LmStudioProvider {
  return new LmStudioProvider({
    url: process.env.LMSTUDIO_URL ?? DEFAULT_LMSTUDIO_URL,
    model: opts.model,
    label: opts.label,
    contextCap: opts.maxContext ?? envNumber("LMSTUDIO_MAX_CONTEXT", Number.POSITIVE_INFINITY),
    visionOverride: visionOverride(process.env.LMSTUDIO_VISION),
    lmsBin: process.env.LMS_BIN ?? "lms",
    admissionGate: opts.admissionGate,
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
    this.gate = config.admissionGate;
    this.client = new LmStudioClient({
      url: config.url,
      model: config.model,
      contextCap: config.contextCap,
      visionOverride: config.visionOverride,
      lmsBin: config.lmsBin,
      providerId: this.id,
      // Serialize `lms load`/`unload` across processes under the endpoint lifecycle lease (M5).
      withLifecycleLease: config.admissionGate
        ? (fn) =>
            config.admissionGate!.withLifecycle(
              { provider: this.id, baseUrl: config.url, model: config.model },
              fn,
            )
        : undefined,
    });
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
    // Generation admission (M6): hold a per-model lease for the whole stream so two local streams for
    // the same LM Studio resource serialize by default (D-003); released when the stream scope closes
    // (completion / failure / cancellation). Without a gate the stream runs unwrapped (cloud parity).
    if (!this.gate) {
      return inner();
    }
    return admittedStream(
      (signal) =>
        this.gate!.acquireGeneration(
          { provider: this.id, baseUrl: this.url, model: this.model },
          { signal },
        ),
      inner,
    );
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
