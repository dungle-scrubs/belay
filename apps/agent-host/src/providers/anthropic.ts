/**
 * The ONE Claude subscription source (53.1 D-001): Claude via the Anthropic (Claude Pro/Max) OAuth in
 * ~/.pi/auth.json, streamed through pi-ai. The in-app "Sign in" runs `loginAnthropic` (PKCE) which
 * writes the `{type:"oauth"}` credential the resolver here reads; pi-ai's anthropic-messages path then
 * auto-detects the resolved OAuth token and streams on the subscription. The separate Anthropic *Direct
 * API* (a plain generated key on the distinct `anthropic-api` entry) is a static-key peer (pi-key.ts),
 * NOT this OAuth path.
 *
 * Responsible for: the Claude subscription OAuth provider - the pi-ai base wired with the anthropic
 * registry lookup and the OAuth credential strategy.
 * Not for: the Anthropic Direct API static-key source (pi-key.ts), the sign-in flow itself
 * (provider-auth.ts `SIGN_IN_TARGETS`), or the source registry (catalog.ts).
 */
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { type PiAiProviderBase, piAiProvider } from "./pi-ai-base";
import { lookupPiModel } from "./pi-model";
import { oauthCredentialResolver } from "./provider-auth";

/** The pi-ai registry id + the ~/.pi/auth.json OAuth entry for the Claude subscription (Claude Pro/Max). */
const ANTHROPIC = "anthropic";

export interface AnthropicConfig {
  /** A model id from pi-ai's anthropic registry, e.g. claude-opus-4-0. */
  readonly model: string;
  /** Human-friendly name for the UI selector. */
  readonly label: string;
}

/**
 * The Claude subscription via the Anthropic (Claude Pro/Max) OAuth in ~/.pi/auth.json, through pi-ai.
 * The same shape as Codex - a PiAiProviderBase with the OAuth credential strategy + a direct registry
 * lookup - since pi-ai resolves the OAuth token to an API key generically (getOAuthApiKey) and the
 * anthropic registry model already carries the right `anthropic-messages` API + base URL. Cloud, so
 * always warm; reasoning options + image support come from the pi-ai model, with a safe fallback so a
 * model id newer than the installed registry still starts the host.
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
