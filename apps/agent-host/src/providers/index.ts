import type { ProviderModel } from "@trevor/richter";
import { CodexProvider } from "./codex";
import { LmStudioProvider } from "./lmstudio";
import type { Provider } from "./types";

export type {
  ChatMessage,
  Provider,
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
  return {
    qwen: new LmStudioProvider({
      url: process.env.LMSTUDIO_URL ?? "http://localhost:1234/v1",
      model: process.env.LMSTUDIO_MODEL ?? "qwen3.6-27b-mlx",
      label: "Qwen (local)",
    }),
    gpt: new CodexProvider({ model: process.env.PIAI_MODEL ?? "gpt-5.5", label: "GPT-5.5" }),
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
