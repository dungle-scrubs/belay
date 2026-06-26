import { type Api, getModel, getModels, type Model } from "@earendil-works/pi-ai/compat";
import { staticKeyCredentialResolver } from "./credentials";
import { PiAiProviderBase } from "./pi-ai-base";

/** Length of the common leading run of two ids (for picking the closest sibling model). */
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

/**
 * The pi-ai model for a static-key provider. The provider/model ids are configurable at runtime;
 * pi-ai validates them against its registry, so the literal casts only satisfy getModel's strict
 * typing.
 *
 * If the id is NOT in the registry (a model newer than the installed pi-ai - e.g. glm-5.2 against
 * a registry that only knows glm-5.1), we synthesize it: clone the closest sibling from the same
 * provider (same api/baseUrl/reasoning shape) and override the id, so a just-released model still
 * resolves. The request carries the new id; if the backend doesn't actually serve it, that
 * surfaces as a stream error, not a silent stall.
 */
export function resolvePiModel(piProvider: string, model: string): Model<Api> {
  // getModel returns undefined (not a throw) for an id absent from the registry; some providers
  // throw instead, so handle both before falling through to synthesis.
  try {
    const found = getModel(piProvider as "deepseek", model as "deepseek-v4-pro");
    if (found) {
      return found as Model<Api>;
    }
  } catch {
    // fall through to synthesis
  }
  const siblings = getModels(piProvider as "deepseek") as Model<Api>[];
  const base = siblings.reduce<Model<Api> | undefined>((best, candidate) => {
    if (!best) {
      return candidate;
    }
    return sharedPrefix(candidate.id, model) >= sharedPrefix(best.id, model) ? candidate : best;
  }, undefined);
  if (!base) {
    throw new Error(`no models registered for pi-ai provider "${piProvider}"`);
  }
  return { ...base, id: model };
}

export interface PiKeyConfig {
  /** Host registry id / display key (e.g. "deepseek", "glm", "minimax"). */
  readonly id: string;
  /** pi-ai provider id whose registry the model lives in (e.g. "deepseek", "zai", "minimax"). */
  readonly piProvider: string;
  /** Top-level key in ~/.pi/auth.json holding `{ key }` for this provider. */
  readonly authName: string;
  /** A model id from the pi-ai `piProvider` registry. */
  readonly model: string;
  /** Human-friendly name for the UI selector. */
  readonly label: string;
}

/**
 * A cloud provider reached through pi-ai with a bearer API key from ~/.pi/auth.json (DeepSeek,
 * Z.ai/GLM, MiniMax). It is a PiAiProviderBase with the static-key credential strategy and the
 * sibling-synthesis model lookup - the streaming/readiness/capabilities template is shared with
 * CodexProvider in the base; only the credential (a static key, not an OAuth token to refresh)
 * and the model resolution (synthesis for a not-yet-registered id) differ. Reasoning options and
 * image support come from the pi-ai model, defaulting to medium, then high, then off.
 */
export class PiKeyProvider extends PiAiProviderBase {
  constructor(config: PiKeyConfig) {
    super({
      id: config.id,
      label: config.label,
      model: config.model,
      credentials: staticKeyCredentialResolver({
        providerId: config.id,
        authName: config.authName,
      }),
      resolveModel: () => resolvePiModel(config.piProvider, config.model),
      fallback: { levels: ["off", "high"], images: false },
      pickDefaultReasoning: (levels) =>
        levels.includes("medium")
          ? "medium"
          : levels.includes("high")
            ? "high"
            : (levels[Math.floor(levels.length / 2)] ?? "off"),
    });
  }
}

// Per-provider roster factories: each owns its pi-ai provider/auth ids and its model-env default
// (DEEPSEEK_MODEL / GLM_MODEL / MINIMAX_MODEL), so registration in buildProviders is one line and
// the browser-facing key (deepseek/glm/minimax) and curated label are the only things index.ts sets.
// The pi-ai provider id (deepseek/zai/minimax) and the auth.json key name match.

/** DeepSeek over a static key. */
export function deepseekProvider(label: string): PiKeyProvider {
  return new PiKeyProvider({
    id: "deepseek",
    piProvider: "deepseek",
    authName: "deepseek",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    label,
  });
}

/** Z.ai / GLM over a static key (browser key "glm", pi-ai/auth name "zai"). */
export function glmProvider(label: string): PiKeyProvider {
  return new PiKeyProvider({
    id: "glm",
    piProvider: "zai",
    authName: "zai",
    model: process.env.GLM_MODEL ?? "glm-5.2",
    label,
  });
}

/** MiniMax over a static key. */
export function minimaxProvider(label: string): PiKeyProvider {
  return new PiKeyProvider({
    id: "minimax",
    piProvider: "minimax",
    authName: "minimax",
    model: process.env.MINIMAX_MODEL ?? "MiniMax-M2.7",
    label,
  });
}
