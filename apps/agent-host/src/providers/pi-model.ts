import type { Api, Model } from "@earendil-works/pi-ai/compat";
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
