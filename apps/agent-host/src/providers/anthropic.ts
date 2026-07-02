/**
 * Responsible for: the Anthropic (Claude Pro/Max) OAuth provider - the pi-ai base wired with the
 * anthropic registry lookup and the OAuth credential strategy.
 */
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { type PiAiProviderBase, piAiProvider } from "./pi-ai-base";
import { lookupPiModel } from "./pi-model";
import { oauthCredentialResolver } from "./provider-auth";

/** The pi-ai registry id + the ~/.pi/auth.json OAuth entry for Anthropic (Claude Pro/Max). */
const ANTHROPIC = "anthropic";

export interface AnthropicConfig {
  /** A model id from pi-ai's anthropic registry, e.g. claude-opus-4-0. */
  readonly model: string;
  /** Human-friendly name for the UI selector. */
  readonly label: string;
}

/**
 * Claude via the Anthropic (Claude Pro/Max) OAuth in ~/.pi/auth.json, through pi-ai. The same shape as
 * Codex - a PiAiProviderBase with the OAuth credential strategy + a direct registry lookup -
 * since pi-ai resolves the OAuth token to an API key generically (getOAuthApiKey) and the anthropic
 * registry model already carries the right `anthropic-messages` API + base URL. Cloud, so always warm;
 * reasoning options + image support come from the pi-ai model, with a safe fallback so a model id
 * newer than the installed registry still starts the host.
 */
export function anthropicProvider(config: AnthropicConfig): PiAiProviderBase {
  return piAiProvider({
    id: "anthropic",
    label: config.label,
    model: config.model,
    credentials: oauthCredentialResolver({ providerId: "anthropic", oauthName: ANTHROPIC }),
    // A registry miss surfaces downstream (pi-ai-base falls back to the declared shape; the stream
    // surfaces an unserved id as an error), as before lookupPiModel centralized the cast.
    resolveModel: () => lookupPiModel(ANTHROPIC, config.model) as Model<Api>,
    fallback: { levels: ["off", "high"], images: true },
  });
}
