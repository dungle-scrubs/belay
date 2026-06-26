import type { ModelRef } from "./model-source";

/**
 * Model selection + reasoning preferences (D-065 M6).
 *
 * The first cut selects ONE active chat model - no routing, no prompt-intent choice, no role-specific
 * assignment. This module is the pure, persistable preferences model behind that: the active model,
 * a remembered default, a capped recent list, pinned models, and a per-model reasoning map. Selecting
 * a model clamps its reasoning to that model's detected surface (so a `high` carried over to a model
 * that only does `off`/`low` is corrected), and `off` is honored only when the surface lists it.
 *
 * Everything here is a pure transition over {@link ModelPreferences} plus a tolerant decoder for the
 * persisted JSON; the legacy `provider` string bridges in through {@link ModelRef} (model-source.ts),
 * so selection keeps working through the migration. No routing or role-specific state exists to
 * mutate, which is how "no routing side effects" is structural rather than merely tested.
 */

/** The persisted model-selection preferences. `reasoningByModel` is keyed by `sourceId/modelId`. */
export interface ModelPreferences {
  readonly active: ModelRef | null;
  readonly default: ModelRef | null;
  readonly recent: readonly ModelRef[];
  readonly pinned: readonly ModelRef[];
  readonly reasoningByModel: Readonly<Record<string, string>>;
}

/** The empty preferences (nothing selected yet). */
export const EMPTY_PREFERENCES: ModelPreferences = {
  active: null,
  default: null,
  recent: [],
  pinned: [],
  reasoningByModel: {},
};

/** How many models the recent list remembers (newest first). */
export const RECENT_LIMIT = 8;

/** A model's detected reasoning surface: the levels it supports and the level to default to. */
export interface ReasoningSurface {
  readonly levels: readonly string[];
  readonly default: string;
}

/** The stable map key for a model reference. */
export function modelRefKey(ref: Pick<ModelRef, "sourceId" | "modelId">): string {
  return `${ref.sourceId}/${ref.modelId}`;
}

/** Whether two references point at the same model (ignoring reasoning). */
export function sameModel(
  a: Pick<ModelRef, "sourceId" | "modelId">,
  b: Pick<ModelRef, "sourceId" | "modelId">,
): boolean {
  return a.sourceId === b.sourceId && a.modelId === b.modelId;
}

/**
 * Clamps a requested reasoning to a model's detected surface: the request when the surface lists it
 * (so `off` works only when the surface offers it), else the surface default when valid, else the
 * first declared level, else null for a model with no reasoning surface at all.
 */
export function constrainReasoning(
  surface: ReasoningSurface,
  requested: string | null,
): string | null {
  if (surface.levels.length === 0) {
    return null;
  }
  if (requested != null && surface.levels.includes(requested)) {
    return requested;
  }
  if (surface.levels.includes(surface.default)) {
    return surface.default;
  }
  return surface.levels[0] ?? null;
}

/**
 * Selects a model active: clamps its reasoning to the model's surface, records that per-model
 * reasoning, and moves the model to the front of the (deduped, capped) recent list. Pinned + default
 * are untouched. No routing or role state is created - the only changes are active/recent/reasoning.
 */
export function selectModel(
  prefs: ModelPreferences,
  ref: ModelRef,
  surface: ReasoningSurface,
): ModelPreferences {
  const reasoning = constrainReasoning(surface, ref.reasoning);
  const active: ModelRef = { sourceId: ref.sourceId, modelId: ref.modelId, reasoning };
  const key = modelRefKey(ref);
  const recent = [active, ...prefs.recent.filter((r) => modelRefKey(r) !== key)].slice(
    0,
    RECENT_LIMIT,
  );
  const reasoningByModel =
    reasoning != null ? { ...prefs.reasoningByModel, [key]: reasoning } : prefs.reasoningByModel;
  return { ...prefs, active, recent, reasoningByModel };
}

/** Remembers `ref` as the default model (the one a fresh session starts on). */
export function setDefaultModel(prefs: ModelPreferences, ref: ModelRef): ModelPreferences {
  return { ...prefs, default: ref };
}

/** Pins a model (idempotent); pinned models survive recent-list eviction. */
export function pinModel(prefs: ModelPreferences, ref: ModelRef): ModelPreferences {
  if (prefs.pinned.some((r) => sameModel(r, ref))) {
    return prefs;
  }
  return { ...prefs, pinned: [...prefs.pinned, ref] };
}

/** Unpins a model (no-op when it was not pinned). */
export function unpinModel(
  prefs: ModelPreferences,
  ref: Pick<ModelRef, "sourceId" | "modelId">,
): ModelPreferences {
  return { ...prefs, pinned: prefs.pinned.filter((r) => !sameModel(r, ref)) };
}

/** The persisted reasoning for a model: its per-model record, else the ref's own reasoning, else null. */
export function reasoningForModel(prefs: ModelPreferences, ref: ModelRef): string | null {
  return prefs.reasoningByModel[modelRefKey(ref)] ?? ref.reasoning ?? null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** Decodes a persisted {@link ModelRef}, or null when the shape is unusable (no source/model id). */
function decodeRef(v: unknown): ModelRef | null {
  const r = asRecord(v);
  if (typeof r.sourceId !== "string" || typeof r.modelId !== "string") {
    return null;
  }
  return {
    sourceId: r.sourceId,
    modelId: r.modelId,
    reasoning: typeof r.reasoning === "string" ? r.reasoning : null,
  };
}

const decodeRefList = (v: unknown): ModelRef[] =>
  Array.isArray(v) ? v.map(decodeRef).filter((r): r is ModelRef => r != null) : [];

/**
 * Decodes persisted preferences from JSON, dropping any unusable entries so a corrupt or partial
 * store loads to a safe value instead of throwing. The recent list is re-capped on the way in.
 */
export function decodeModelPreferences(v: unknown): ModelPreferences {
  const r = asRecord(v);
  const reasoningByModel: Record<string, string> = {};
  for (const [k, val] of Object.entries(asRecord(r.reasoningByModel))) {
    if (typeof val === "string") {
      reasoningByModel[k] = val;
    }
  }
  return {
    active: decodeRef(r.active),
    default: decodeRef(r.default),
    recent: decodeRefList(r.recent).slice(0, RECENT_LIMIT),
    pinned: decodeRefList(r.pinned),
    reasoningByModel,
  };
}
