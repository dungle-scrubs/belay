import { codexProvider } from "./codex";
import { lmStudioProvider } from "./lmstudio";
import { PI_KEY_PROVIDERS, piKeyProvider } from "./pi-key";
import type { Provider } from "./types";

// The provider error classes are part of the package's public surface: callers discriminate
// failures by these tags. Re-exporting them here keeps `errors.ts` internal so its taxonomy can
// be refactored without touching callsites.
export {
  ModelLoadError,
  ProviderAuthError,
  type ProviderFailureEvidence,
  ProviderUnavailable,
  providerFailureEvidence,
} from "./errors";
export {
  incidentReasonOf,
  protocolAnomalyDiagnostic,
  providerDiagnostic,
} from "./provider-diagnostic";
export {
  incidentCategory,
  type ProviderIncident,
  type ProviderIncidentCategory,
  ProviderIncidentLog,
  providerIncidents,
} from "./provider-incidents";
export type {
  ChatImage,
  ChatMessage,
  ModelEvent,
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

/**
 * Builds the provider registry the host switches between per message. The host is the single source
 * of the announced roster (host.online): each entry is the browser-facing KEY plus a per-provider
 * factory that resolves its OWN env (model defaults, LM Studio infra) and carries the curated
 * display label. Registration is one line per provider; env-var resolution lives with each provider
 * (codex.ts / pi-key.ts / lmstudio.ts), not in this block. Reasoning options are auto-detected by
 * the adapter (pi-ai registry / LM Studio). Nothing is duplicated in a shared package - the web
 * renders whatever the host announces.
 */
export function buildProviders(): ProviderRegistry {
  return {
    // Two qwen3.6-27b quants now coexist in LM Studio, so the bare "qwen3.6-27b-mlx"
    // key is ambiguous - pin each to its org-prefixed id.
    qwen: lmStudioProvider({
      model: process.env.LMSTUDIO_MODEL ?? "unsloth/qwen3.6-27b-mlx",
      label: "Qwen 27B 8-bit (local)",
    }),
    gpt: codexProvider("GPT-5.5"),
    // Loaded at 64k - the working window, and the target compaction (D-036) keeps the prompt under
    // by summarizing old turns. qwen3.6 is natively 256k-capable; 64k is the load cap we operate at
    // (a balance of headroom vs. KV-cache memory). Overflow recovery (D-034) was validated against a
    // tiny 6k cap; normal runs use 64k with compaction as the primary defense and recovery beneath it.
    qwen4bit: lmStudioProvider({
      model: "lmstudio-community/qwen3.6-27b-mlx",
      label: "Qwen 27B 4-bit (local)",
      maxContext: 65536,
    }),
    // The static-key cloud providers (DeepSeek, Z.ai/GLM, MiniMax) come from one registry
    // (pi-key.ts), so adding one is a single row there - not a line here plus a factory body.
    ...Object.fromEntries(PI_KEY_PROVIDERS.map((def) => [def.key, piKeyProvider(def)])),
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
