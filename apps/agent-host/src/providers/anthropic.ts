import { getModel } from "@earendil-works/pi-ai/compat";
import { oauthCredentialResolver } from "./credentials";
import { PiAiProviderBase } from "./pi-ai-base";

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
 * CodexProvider - a PiAiProviderBase with the OAuth credential strategy + a direct registry lookup -
 * since pi-ai resolves the OAuth token to an API key generically (getOAuthApiKey) and the anthropic
 * registry model already carries the right `anthropic-messages` API + base URL. Cloud, so always warm;
 * reasoning options + image support come from the pi-ai model, with a safe fallback so a model id
 * newer than the installed registry still starts the host.
 */
export class AnthropicProvider extends PiAiProviderBase {
  constructor(config: AnthropicConfig) {
    super({
      id: "anthropic",
      label: config.label,
      model: config.model,
      credentials: oauthCredentialResolver({ providerId: "anthropic", oauthName: ANTHROPIC }),
      // The model id is configurable at runtime; pi-ai validates it against its registry, so the
      // literal cast only satisfies getModel's strict typing.
      resolveModel: () => getModel(ANTHROPIC, config.model as "claude-opus-4-0"),
      fallback: { levels: ["off", "high"], images: true },
      pickDefaultReasoning: (levels) =>
        levels.includes("medium")
          ? "medium"
          : levels.includes("high")
            ? "high"
            : (levels[0] ?? "off"),
    });
  }
}
