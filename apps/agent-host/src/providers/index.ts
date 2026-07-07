/**
 * Responsible for: the providers package barrel - the public re-exports plus the host provider
 * registry (buildProviders / pickProvider).
 * Not for: per-provider construction; each adapter module owns its own factory and env reads.
 */
import type { LocalAdmissionGate } from "../admission/service";
import type { ResidencyRecorder } from "../residency/registry";
import { codexProvider } from "./codex";
import { lmStudioProvider, lmsBin } from "./lmstudio";
import { pickProviderFromRegistry } from "./model-source-resolver";
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
  createModelSourceResolver,
  type ModelSourceResolver,
  pickProviderFromRegistry,
  type ResolvedTurnProvider,
  type TurnProviderInput,
} from "./model-source-resolver";
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

// The LM Studio CLI binary resolver, so the host's residency unload uses the same `lms` as the provider.
export { lmsBin };

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
export function buildProviders(
  opts: {
    readonly admissionGate?: LocalAdmissionGate;
    /** The host residency registry both local slots record their loads into (plan 11.1). */
    readonly residency?: ResidencyRecorder;
  } = {},
): ProviderRegistry {
  const admissionGate = opts.admissionGate;
  const residency = opts.residency;
  return {
    // Two qwen3.6-27b quants now coexist in LM Studio, so the bare "qwen3.6-27b-mlx"
    // key is ambiguous - pin each to its org-prefixed id.
    qwen: lmStudioProvider({
      model: process.env.LMSTUDIO_MODEL ?? "unsloth/qwen3.6-27b-mlx",
      label: "Qwen 27B 8-bit (local)",
      admissionGate,
      residency,
    }),
    gpt: codexProvider("GPT-5.5"),
    // Both local qwen slots load at the bounded DEFAULT_LOCAL_CONTEXT_CAP (64k) - the working window -
    // CONSISTENTLY (plan 11.1 D-005): qwen3.6 is natively 256k-capable, but 64k is the load cap we
    // operate at (a balance of headroom vs. KV-cache memory), and target compaction (D-036) keeps the
    // prompt under it. The 8-bit slot above used to load at native 256k by accident; both now cap via
    // the factory default. Overflow recovery (D-034) sits beneath compaction.
    qwen4bit: lmStudioProvider({
      model: "lmstudio-community/qwen3.6-27b-mlx",
      label: "Qwen 27B 4-bit (local)",
      admissionGate,
      residency,
    }),
    // The static-key cloud providers (DeepSeek, Z.ai/GLM, MiniMax) come from one registry
    // (pi-key.ts), so adding one is a single row there - not a line here plus a factory body.
    ...Object.fromEntries(PI_KEY_PROVIDERS.map((def) => [def.key, piKeyProvider(def)])),
  };
}

/** Resolves the provider key the browser chose to a concrete provider (default if unknown). */
export function pickProvider(providers: ProviderRegistry, key: unknown): Provider {
  return pickProviderFromRegistry(providers, key, DEFAULT_PROVIDER);
}
