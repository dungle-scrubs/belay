import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { type PiAiProviderBase, piAiProvider } from "./pi-ai-base";
import { lookupPiModel } from "./pi-model";
import { staticKeyCredentialResolver } from "./provider-auth";

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
 * pi-ai validates them against its registry, so the literal casts only satisfy the registry lookup's
 * strict typing.
 *
 * If the id is NOT in the registry (a model newer than the installed pi-ai - e.g. glm-5.2 against
 * a registry that only knows glm-5.1), we synthesize it: clone the closest sibling from the same
 * provider (same api/baseUrl/reasoning shape) and override the id, so a just-released model still
 * resolves. The request carries the new id; if the backend doesn't actually serve it, that
 * surfaces as a stream error, not a silent stall.
 */
export function resolvePiModel(piProvider: string, model: string): Model<Api> {
  // lookupPiModel normalizes the undefined-or-throw a missing registry id surfaces as; a hit is the
  // registry model, a miss falls through to synthesis below.
  const found = lookupPiModel(piProvider, model);
  if (found) {
    return found;
  }
  const siblings = getBuiltinModels(piProvider as "deepseek") as Model<Api>[];
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
 * Codex in the base; only the credential (a static key, not an OAuth token to refresh)
 * and the model resolution (synthesis for a not-yet-registered id) differ. Reasoning options and
 * image support come from the pi-ai model, defaulting to medium, then high, then off.
 */
export function piKeyProviderFromConfig(config: PiKeyConfig): PiAiProviderBase {
  return piAiProvider({
    id: config.id,
    label: config.label,
    model: config.model,
    credentials: staticKeyCredentialResolver({
      providerId: config.id,
      authName: config.authName,
    }),
    resolveModel: () => resolvePiModel(config.piProvider, config.model),
    fallback: { levels: ["off", "high"], images: false },
  });
}

/**
 * One row per static-key cloud provider reached through pi-ai. Each owns the browser-facing key,
 * its pi-ai provider id (which doubles as the `~/.pi/auth.json` entry name), its model-env override,
 * its default model, and the labels both consumers need. This is the single source of provider
 * config: `buildProviders` (index.ts) spreads it into the roster, and the catalog (catalog.ts)
 * derives its api-key SOURCE rows from it - so adding a pi-key provider is one row here, not three
 * near-identical factory bodies plus duplicate source/anomaly entries.
 *
 * For these providers the pi-ai provider id, the auth.json key name, and the catalog source id all
 * coincide (deepseek/zai/minimax); the browser KEY differs only for Z.ai (key "glm", pi/auth "zai").
 */
export interface PiKeyProviderDef {
  /** Browser-facing registry key + provider id (user.message.provider). */
  readonly key: string;
  /** pi-ai provider id whose registry the model lives in; also the auth.json entry + catalog source id. */
  readonly piProvider: string;
  /** Env var that overrides the default model. */
  readonly modelEnvVar: string;
  /** Model id used when the env var is unset. */
  readonly defaultModel: string;
  /** Curated display label for the host roster (buildProviders). */
  readonly rosterLabel: string;
  /** Display label for the D-065 catalog source. */
  readonly sourceLabel: string;
}

export const PI_KEY_PROVIDERS: readonly PiKeyProviderDef[] = [
  {
    key: "deepseek",
    piProvider: "deepseek",
    modelEnvVar: "DEEPSEEK_MODEL",
    defaultModel: "deepseek-v4-pro",
    rosterLabel: "DeepSeek V4 Pro",
    sourceLabel: "DeepSeek",
  },
  {
    key: "glm",
    piProvider: "zai",
    modelEnvVar: "GLM_MODEL",
    defaultModel: "glm-5.2",
    rosterLabel: "GLM-5.2 (Z.ai)",
    sourceLabel: "Z.ai",
  },
  {
    key: "minimax",
    piProvider: "minimax",
    modelEnvVar: "MINIMAX_MODEL",
    defaultModel: "MiniMax-M2.7",
    rosterLabel: "MiniMax M2.7",
    sourceLabel: "MiniMax",
  },
];

/**
 * Builds the pi-ai provider for one registry row, resolving its model from the env override
 * or the default. This is the single parameterized factory the three former named factories collapsed
 * into; the roster label comes from the row.
 */
export function piKeyProvider(def: PiKeyProviderDef): PiAiProviderBase {
  return piKeyProviderFromConfig({
    id: def.key,
    piProvider: def.piProvider,
    authName: def.piProvider,
    model: process.env[def.modelEnvVar] ?? def.defaultModel,
    label: def.rosterLabel,
  });
}
