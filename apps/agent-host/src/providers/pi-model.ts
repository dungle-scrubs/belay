/**
 * Responsible for: the tolerant pi-ai registry model lookup - normalizing undefined-or-throw
 * misses and owning the literal casts the registry's strict typing needs - and the shared
 * model-shape derivation (reasoning levels, image support, bundled window) with a declared
 * fallback so the host still starts on a registry miss.
 */
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

/**
 * Looks up a pi-ai registry model by `provider` + `id`, tolerating BOTH ways an id absent from the
 * installed registry surfaces: `getBuiltinModel` returns undefined for some providers and throws for
 * others. This is the ONE place that owns the literal casts the strict typing needs (provider/model
 * ids are configurable at runtime, validated by pi-ai, so the casts only satisfy the compiler) and the
 * undefined-or-throw normalization, so every caller reads a plain `Model<Api> | undefined`.
 */
export function lookupPiModel(provider: string, id: string): Model<Api> | undefined {
  try {
    return getBuiltinModel(provider as "deepseek", id as "deepseek-v4-pro") as
      | Model<Api>
      | undefined;
  } catch {
    return undefined;
  }
}

/** The declared shape to assume when a model id is not (yet) in the installed registry. */
export interface ModelShapeFallback {
  readonly levels: readonly string[];
  readonly images: boolean;
}

/** A model's advertised shape: thinking levels, image support, and (when resolved) the bundled window. */
export interface ModelShape {
  readonly levels: readonly string[];
  readonly images: boolean;
  /** The registry's bundled context window; absent on a registry miss (the fallback shape). */
  readonly contextWindow?: number;
}

/**
 * Derives a model's thinking options + image support (+ bundled window) from its resolved registry
 * entry, falling back to the provider's declared shape when the id is not in the installed registry -
 * so a just-released model id still starts the host. `resolveModel` may return undefined or throw for
 * a miss; both degrade to the fallback. The one owner of this derivation, shared by the pi-ai cloud
 * base and the Claude subscription provider so their constructors can't drift.
 */
export function deriveModelShape(
  resolveModel: () => Model<Api> | undefined,
  fallback: ModelShapeFallback,
): ModelShape {
  try {
    const model = resolveModel();

    if (!model) {
      return { levels: fallback.levels, images: fallback.images };
    }

    return {
      levels: getSupportedThinkingLevels(model),
      images: model.input?.includes("image") ?? fallback.images,
      contextWindow: model.contextWindow,
    };
  } catch {
    return { levels: fallback.levels, images: fallback.images };
  }
}
