import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { type PiAiProviderBase, piAiProvider } from "./pi-ai-base";
import { lookupPiModel } from "./pi-model";
import { oauthCredentialResolver } from "./provider-auth";

/** The pi-ai registry + OAuth key for GPT-5.x (distinct from this provider's "codex" id). */
const CODEX = "openai-codex";

export interface CodexConfig {
  /** A model id from pi-ai's openai-codex registry, e.g. gpt-5.5 */
  readonly model: string;
  /** Human-friendly name for the UI selector. */
  readonly label: string;
}

/**
 * GPT-5.x via the OpenAI Codex OAuth in ~/.pi/auth.json, through pi-ai. Cloud, so always warm.
 * It is a PiAiProviderBase with the OAuth credential strategy and a direct registry lookup -
 * the streaming/readiness/capabilities template, tool calling, and reasoning detection all live
 * in the base. GPT-5.x reasoning is graduated (minimal..xhigh), read from the pi-ai model and
 * defaulting to medium; a model id newer than the installed registry falls back to that shape so
 * the host still starts.
 */
export function codexProviderFromConfig(config: CodexConfig): PiAiProviderBase {
  return piAiProvider({
    id: "codex",
    label: config.label,
    model: config.model,
    credentials: oauthCredentialResolver({ providerId: "codex", oauthName: CODEX }),
    // A registry miss surfaces downstream (pi-ai-base falls back to the declared shape; the stream
    // surfaces an unserved id as an error), as before lookupPiModel centralized the cast.
    resolveModel: () => lookupPiModel(CODEX, config.model) as Model<Api>,
    fallback: { levels: ["minimal", "low", "medium", "high", "xhigh"], images: true },
  });
}

/** Builds the Codex provider for the roster, resolving its model env (PIAI_MODEL) here so
 *  registration in buildProviders is one line. The label is the curated roster string. */
export function codexProvider(label: string): PiAiProviderBase {
  return codexProviderFromConfig({ model: process.env.PIAI_MODEL ?? "gpt-5.5", label });
}
