import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { type PiAiProviderBase, piAiProvider } from "./pi-ai-base";
import { staticKeyCredentialResolver } from "./provider-auth";

/**
 * A cloud provider reached over a plain OpenAI-compatible endpoint (`/v1/chat/completions`,
 * `/v1/models`) that is NOT in pi-ai's bundled registry - Ollama Cloud is the first such source.
 *
 * The other cloud providers (DeepSeek/Z.ai/MiniMax/OpenRouter) resolve their pi-ai Model from the
 * registry (or synthesize it from a sibling). An endpoint pi-ai has never heard of has no sibling to
 * clone, so we construct the Model DIRECTLY here: its `openai-completions` API, the endpoint's base
 * URL, and a conservative context/reasoning shape. The model id is whatever the endpoint's live
 * `/v1/models` advertised (e.g. Ollama's "gpt-oss:120b", "glm-5:cloud", "qwen3-coder:480b-cloud").
 *
 * Everything else - streaming, readiness, capabilities, the credential read - is the shared
 * PiAiProviderBase template with the static-key strategy, so this stays a thin model-construction
 * shim. Reasoning is left off by default: a model pi-ai doesn't know has no verified thinking format,
 * and sending the wrong one would break the turn; that enrichment is a follow-up per model family.
 *
 * Responsible for: providers for OpenAI-compatible endpoints outside pi-ai's registry - direct
 * Model construction over the shared pi-ai base.
 * Not for: registry-backed static-key providers; those live in pi-key.ts.
 */
export interface OpenAICompatConfig {
  /** Host source/provider id used in the error envelope + roster, e.g. "ollama". */
  readonly id: string;
  /** Top-level key in ~/.pi/auth.json holding `{ key }` for this endpoint. */
  readonly authName: string;
  /** The OpenAI-compatible base URL, e.g. "https://ollama.com/v1". */
  readonly baseUrl: string;
  /** The model id to run (as advertised by the endpoint's /v1/models). */
  readonly model: string;
  /** Human-friendly name for the UI selector. */
  readonly label: string;
  /** Advertised context window (tokens) for budgeting; a safe default when the real value is unknown. */
  readonly contextWindow?: number;
}

/** Builds the pi-ai Model for an OpenAI-compatible endpoint that has no registry entry to clone. */
export function openAICompatModel(config: {
  readonly id: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly contextWindow: number;
}): Model<Api> {
  return {
    id: config.id,
    name: config.id,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: config.baseUrl,
    compat: { supportsStore: false, supportsDeveloperRole: false },
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: 32768,
  } as Model<Api>;
}

export function openAICompatProvider(config: OpenAICompatConfig): PiAiProviderBase {
  return piAiProvider({
    id: config.id,
    label: config.label,
    model: config.model,
    credentials: staticKeyCredentialResolver({
      providerId: config.id,
      authName: config.authName,
    }),
    resolveModel: () =>
      openAICompatModel({
        id: config.model,
        provider: config.id,
        baseUrl: config.baseUrl,
        contextWindow: config.contextWindow ?? 131072,
      }),
    fallback: { levels: ["off"], images: false },
    pickDefaultReasoning: () => "off",
  });
}
