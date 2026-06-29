/**
 * Correctable per-model metadata overrides (02.16 D-003). Provider `/models` endpoints return only
 * `{id, name}`, so the catalog looks up per-model metadata (context window, reasoning, vision) from
 * pi-ai's BUNDLED static registry. That registry can carry a STALE value - the motivating case was
 * MiniMax-M3, whose bundled `contextWindow` (512000) understates the model card's real 1M, so the
 * picker rendered a wrong window and the context-pressure gate fired far too early. There is no live
 * source for context windows, so the fix is a correctable override that WINS over the bundled value,
 * not a "pull it from the API".
 *
 * Corrections are USER-OWNED: they live in a hand-edited `<TREVOR_HOME>/models.json` (see
 * {@link USER_MODELS_JSON}), the same way pi-ai keeps `~/.pi/auth.json`, so a wrong window is fixed by
 * editing config rather than shipping a code change. The file is read once per host (and on
 * `/catalog-refresh` via {@link reloadModelOverrides}); absent or malformed, it contributes nothing.
 * {@link MODEL_METADATA_OVERRIDES} below is the empty BUILT-IN baseline the config layers over - kept
 * for a code-level correction we'd ship ahead of any user edit; the user file always wins.
 */

import { readFileSync } from "node:fs";
import { warn } from "../log";
import { USER_MODELS_JSON } from "../paths";

export interface ModelMetadataOverride {
  /** The corrected context window (tokens) when pi-ai's bundled value is stale. */
  readonly contextWindow?: number;
}

/**
 * Built-in baseline corrections keyed by `modelId` (the live `/models` id). Intentionally EMPTY:
 * corrections are user-owned in `<TREVOR_HOME>/models.json`. An entry is added here only for a
 * correction we want shipped in code ahead of any user file; the user file overrides it regardless.
 */
export const MODEL_METADATA_OVERRIDES: Readonly<Record<string, ModelMetadataOverride>> = {};

/**
 * Parses a raw `models.json` value into a clean overrides map, keeping only well-formed entries
 * (`{ contextWindow: <positive finite number> }`) and silently skipping anything else, so one bad
 * entry never discards the rest. Pure - no I/O.
 */
export function parseModelOverrides(raw: unknown): Record<string, ModelMetadataOverride> {
  const out: Record<string, ModelMetadataOverride> = {};
  if (typeof raw !== "object" || raw === null) {
    return out;
  }
  for (const [modelId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const contextWindow = (value as { contextWindow?: unknown }).contextWindow;
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
      out[modelId] = { contextWindow };
    }
  }
  return out;
}

/**
 * Reads + parses the user's `models.json`. The file is OPTIONAL: a missing/unreadable file yields no
 * overrides silently, while a present-but-malformed file warns once and is ignored rather than crashing
 * the host on a typo. `path`/`read` are injectable so the load is unit-tested without touching disk.
 */
export function loadModelOverridesFile(
  path: string = USER_MODELS_JSON,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Record<string, ModelMetadataOverride> {
  let text: string;
  try {
    text = read(path);
  } catch {
    return {}; // no file (the common case) - no corrections
  }
  try {
    return parseModelOverrides(JSON.parse(text));
  } catch (error) {
    warn("catalog", "models.json present but not valid JSON; ignoring", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * The effective overrides: the built-in baseline with the user's `models.json` layered ON TOP (the
 * user file wins). Memoized so the file is read once per host; {@link reloadModelOverrides} clears it
 * for `/catalog-refresh`, matching how provider keys are re-read.
 */
let activeOverridesCache: Readonly<Record<string, ModelMetadataOverride>> | undefined;

export function activeModelOverrides(): Readonly<Record<string, ModelMetadataOverride>> {
  if (activeOverridesCache === undefined) {
    activeOverridesCache = { ...MODEL_METADATA_OVERRIDES, ...loadModelOverridesFile() };
  }
  return activeOverridesCache;
}

/** Drops the memoized overrides so the next read re-loads `models.json` (host startup / `/catalog-refresh`). */
export function reloadModelOverrides(): void {
  activeOverridesCache = undefined;
}

/**
 * Windows LEARNED from a provider's own overflow error (03.2 M3), keyed by `modelId`. A stale bundled
 * window self-heals the first time the provider rejects a prompt for being too big: the real `N` is
 * captured here and the resolver honors it on later turns. Populated by `recordLearnedWindow`; consulted
 * by `resolveContextWindow` AFTER a static override (which is the trusted correction) and only ever to
 * TIGHTEN toward the bundled value, never to widen past it.
 */
const learnedWindows = new Map<string, number>();

/**
 * The effective context window for a model, by precedence: a confirmed override wins (the user's
 * `models.json` over the built-in baseline), else a learned window (clamped to never exceed the bundled
 * value), else the bundled value; absent all three it is null (unknown - the picker shows no window).
 * Pure given its inputs - `overrides` and `learned` are injectable so the resolution is unit-tested
 * without touching the config file or store; the default `overrides` is the memoized config-aware map.
 */
export function resolveContextWindow(
  modelId: string,
  bundledContextWindow: number | undefined,
  overrides: Readonly<Record<string, ModelMetadataOverride>> = activeModelOverrides(),
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
