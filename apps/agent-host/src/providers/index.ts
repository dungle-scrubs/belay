import { CodexProvider } from "./codex";
import { LmStudioProvider } from "./lmstudio";
import { PiKeyProvider } from "./pi-key";
import type { Provider } from "./types";

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
 * Builds the provider registry the host switches between per message. The host is the
 * single source of the announced roster (host.online): each provider's display label is
 * curated here next to its model id and env override, and its reasoning options are
 * auto-detected by the adapter (pi-ai registry / LM Studio). Nothing is duplicated in a
 * shared package - the web renders whatever the host announces, and an empty picker until
 * then.
 */
export function buildProviders(): ProviderRegistry {
  const lmstudioUrl = process.env.LMSTUDIO_URL ?? "http://localhost:1234/v1";
  return {
    // Two qwen3.6-27b quants now coexist in LM Studio, so the bare "qwen3.6-27b-mlx"
    // key is ambiguous - pin each to its org-prefixed id.
    qwen: new LmStudioProvider({
      url: lmstudioUrl,
      model: process.env.LMSTUDIO_MODEL ?? "unsloth/qwen3.6-27b-mlx",
      label: "Qwen 27B 8-bit (local)",
    }),
    gpt: new CodexProvider({
      model: process.env.PIAI_MODEL ?? "gpt-5.5",
      label: "GPT-5.5",
    }),
    qwen4bit: new LmStudioProvider({
      url: lmstudioUrl,
      model: "lmstudio-community/qwen3.6-27b-mlx",
      label: "Qwen 27B 4-bit (local)",
      // Loaded at 64k - the working window, and the target compaction (D-036) keeps the
      // prompt under by summarizing old turns. qwen3.6 is natively 256k-capable; 64k is the
      // load cap we operate at (a balance of headroom vs. KV-cache memory). Overflow
      // recovery (D-034) was validated against a tiny 6k cap; normal runs use 64k with
      // compaction as the primary defense and recovery as the per-turn airbag beneath it.
      maxContext: 65536,
    }),
    // Cloud providers reached through pi-ai with a static API key from ~/.pi/auth.json.
    // The pi-ai provider id (deepseek/zai/minimax) and the auth.json key name match; the
    // browser-facing registry key is the friendly one (glm, not zai).
    deepseek: new PiKeyProvider({
      id: "deepseek",
      piProvider: "deepseek",
      authName: "deepseek",
      model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
    }),
    glm: new PiKeyProvider({
      id: "glm",
      piProvider: "zai",
      authName: "zai",
      model: process.env.GLM_MODEL ?? "glm-5.2",
      label: "GLM-5.2 (Z.ai)",
    }),
    minimax: new PiKeyProvider({
      id: "minimax",
      piProvider: "minimax",
      authName: "minimax",
      model: process.env.MINIMAX_MODEL ?? "MiniMax-M2.7",
      label: "MiniMax M2.7",
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
