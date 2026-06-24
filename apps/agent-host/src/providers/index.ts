import { DEFAULT_PROVIDER_MODELS, type ProviderModel } from "@trevor/session";
import { CodexProvider } from "./codex";
import { LmStudioProvider } from "./lmstudio";
import type { Provider } from "./types";

export type {
  ChatImage,
  ChatMessage,
  Provider,
  ProviderError,
  ProviderEvent,
  Readiness,
  ToolCall,
  ToolDef,
  Usage,
} from "./types";

/** The selectable providers, keyed by the id the browser sends (user.message.provider). */
export type ProviderRegistry = Record<string, Provider>;

export const DEFAULT_PROVIDER = "qwen";

/** Builds the provider registry the host switches between per message. */
export function buildProviders(): ProviderRegistry {
  const lmstudioUrl = process.env.LMSTUDIO_URL ?? "http://localhost:1234/v1";
  return {
    // Two qwen3.6-27b quants now coexist in LM Studio, so the bare "qwen3.6-27b-mlx"
    // key is ambiguous - pin each to its org-prefixed id.
    qwen: new LmStudioProvider({
      url: lmstudioUrl,
      model: process.env.LMSTUDIO_MODEL ?? "unsloth/qwen3.6-27b-mlx",
      label: DEFAULT_PROVIDER_MODELS.qwen.label,
    }),
    gpt: new CodexProvider({
      model: process.env.PIAI_MODEL ?? "gpt-5.5",
      label: DEFAULT_PROVIDER_MODELS.gpt.label,
    }),
    qwen4bit: new LmStudioProvider({
      url: lmstudioUrl,
      model: "lmstudio-community/qwen3.6-27b-mlx",
      label: DEFAULT_PROVIDER_MODELS.qwen4bit.label,
      // Loaded at 64k - the working window, and the target compaction (D-036) keeps the
      // prompt under by summarizing old turns. qwen3.6 is natively 256k-capable; 64k is the
      // load cap we operate at (a balance of headroom vs. KV-cache memory). Overflow
      // recovery (D-034) was validated against a tiny 6k cap; normal runs use 64k with
      // compaction as the primary defense and recovery as the per-turn airbag beneath it.
      maxContext: 65536,
    }),
  };
}

/** Resolves the provider key the browser chose to a concrete provider (default if unknown). */
export function pickProvider(providers: ProviderRegistry, key: unknown): Provider {
  const byKey = typeof key === "string" ? providers[key] : undefined;
  const provider = byKey ?? providers[DEFAULT_PROVIDER];
  if (!provider) {
    throw new Error(`no provider for "${String(key)}" and no "${DEFAULT_PROVIDER}" default`);
  }
  return provider;
}

/** Describes each provider's label/model/reasoning options for the host.online announcement. */
export function describeProviders(providers: ProviderRegistry): Record<string, ProviderModel> {
  const out: Record<string, ProviderModel> = {};
  for (const [key, provider] of Object.entries(providers)) {
    out[key] = {
      label: provider.label,
      model: provider.model,
      reasoningLevels: provider.reasoningLevels,
      defaultReasoning: provider.defaultReasoning,
    };
  }
  return out;
}
