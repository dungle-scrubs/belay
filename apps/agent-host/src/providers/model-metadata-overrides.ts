/**
 * Correctable per-model metadata overrides (02.16 D-003). Provider `/models` endpoints return only
 * `{id, name}`, so the catalog looks up per-model metadata (context window, reasoning, vision) from
 * pi-ai's BUNDLED static registry. That registry can carry a STALE value - the motivating case was a
 * MiniMax model whose bundled `contextWindow` (512000) no longer matched reality, so the picker
 * faithfully rendered a wrong window. There is no live source for context windows, so the fix is a
 * correctable override that WINS over the bundled value, not a "pull it from the API".
 *
 * Keep this map MINIMAL: add only a confirmed correction, and prefer a pi-ai bump when one fixes the
 * value upstream (the override stays as the durable correctness layer regardless). It is the single
 * place a wrong window is corrected, beside the catalog source-of-truth rather than scattered across
 * consumers. Empty by default in this build - the installed `@mariozechner/pi-ai` carries no known
 * stale window worth overriding here; an entry is added the moment one is confirmed.
 */

export interface ModelMetadataOverride {
  /** The corrected context window (tokens) when pi-ai's bundled value is stale. */
  readonly contextWindow?: number;
}

/** Confirmed corrections keyed by `modelId` (the live `/models` id). Empty until a stale value is found. */
export const MODEL_METADATA_OVERRIDES: Readonly<Record<string, ModelMetadataOverride>> = {};

/**
 * The context window to render for a model: a confirmed override wins over pi-ai's bundled value;
 * absent both, it is null (unknown, the picker shows no window). Pure - `overrides` is injectable so the
 * resolution is unit-tested without depending on the production map's (intentionally empty) contents.
 */
export function resolveContextWindow(
  modelId: string,
  bundledContextWindow: number | undefined,
  overrides: Readonly<Record<string, ModelMetadataOverride>> = MODEL_METADATA_OVERRIDES,
): number | null {
  const override = overrides[modelId]?.contextWindow;
  if (typeof override === "number") {
    return override;
  }
  return typeof bundledContextWindow === "number" ? bundledContextWindow : null;
}
