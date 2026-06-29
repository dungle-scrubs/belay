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

/** Confirmed corrections keyed by `modelId` (the live `/models` id). */
export const MODEL_METADATA_OVERRIDES: Readonly<Record<string, ModelMetadataOverride>> = {
  // MiniMax-M3's bundled window (512000) overstates the real 262144: session
  // trevor-20260629-033048z-eb100ca0 grew a ~412k-token prompt that the bundled value declared safe,
  // so the fold never fired and the turn overflowed against the real ceiling (03.2 D-004).
  "MiniMax-M3": { contextWindow: 262_144 },
};

/**
 * Windows LEARNED from a provider's own overflow error (03.2 M3), keyed by `modelId`. A stale bundled
 * window self-heals the first time the provider rejects a prompt for being too big: the real `N` is
 * captured here and the resolver honors it on later turns. Populated by `recordLearnedWindow`; consulted
 * by `resolveContextWindow` AFTER a static override (which is the trusted correction) and only ever to
 * TIGHTEN toward the bundled value, never to widen past it.
 */
const learnedWindows = new Map<string, number>();

/**
 * The effective context window for a model, by precedence: a confirmed static override wins, else a
 * learned window (clamped to never exceed the bundled value), else the bundled value; absent all three
 * it is null (unknown - the picker shows no window). Pure - `overrides` and `learned` are injectable so
 * the resolution is unit-tested without touching the production map or store.
 */
export function resolveContextWindow(
  modelId: string,
  bundledContextWindow: number | undefined,
  overrides: Readonly<Record<string, ModelMetadataOverride>> = MODEL_METADATA_OVERRIDES,
  learned: ReadonlyMap<string, number> = learnedWindows,
): number | null {
  const override = overrides[modelId]?.contextWindow;
  if (typeof override === "number") {
    return override;
  }
  const learnedWindow = learned.get(modelId);
  if (typeof learnedWindow === "number") {
    // A learned window only TIGHTENS: a mislabeled/transient signal can never widen a model past its
    // bundled value (and a static override above already short-circuits it entirely).
    return typeof bundledContextWindow === "number"
      ? Math.min(learnedWindow, bundledContextWindow)
      : learnedWindow;
  }
  return typeof bundledContextWindow === "number" ? bundledContextWindow : null;
}

/**
 * Records a window LEARNED from a provider's overflow error (03.2 M3), keyed by `modelId`. Monotonic
 * and only-tightening: it stores `window` only when it is a positive number STRICTLY below any value
 * already learned for the model, so a spurious or transient signal can never widen a learned window
 * (and the resolver clamps it to the bundled value besides). Returns true when the store changed, so a
 * caller can log the self-heal exactly once per genuine tightening. `store` is injectable for tests.
 */
export function recordLearnedWindow(
  modelId: string,
  window: number,
  store: Map<string, number> = learnedWindows,
): boolean {
  if (!Number.isFinite(window) || window <= 0) {
    return false;
  }
  const existing = store.get(modelId);
  if (existing !== undefined && window >= existing) {
    return false;
  }
  store.set(modelId, window);
  return true;
}
