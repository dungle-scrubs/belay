import {
  type CatalogEntry,
  catalogEntryFromProviderModel,
  type ModelRef,
  modelRefFromProvider,
  type ProviderModel,
  type ReasoningSurface,
  type SourceSummary,
} from "@trevor/session";

/**
 * The model-selection projection (D-065 M3): during migration the full chooser + split control are fed
 * by projecting the LEGACY provider roster (host.online `models`) into the new source/catalog contract
 * through the shared bridges - so the host announces no new read model yet and the browser still
 * hardcodes nothing. Richer host-owned read models (gateway catalogs, real auth freshness, OAuth vs
 * direct-key source types) layer in later (D-065 M4 host work). Pure over the roster, so every
 * projection is unit-tested without React.
 */

type Roster = Readonly<Record<string, ProviderModel>>;

/**
 * One {@link SourceSummary} per announced provider: a configured, ready, single-model source. The
 * source TYPE is approximated from the model's run location (local vs cloud) during migration - a
 * cloud provider reads as a direct API-key source, since the legacy roster carries no OAuth/gateway
 * distinction; the host supplies the real type once it owns the source read model.
 */
export function sourcesFromRoster(roster: Roster): SourceSummary[] {
  return Object.entries(roster).map(
    ([sourceId, pm]): SourceSummary => ({
      sourceId,
      type: pm.kind === "local" ? "local" : "api-key",
      label: pm.label,
      status: "ready",
      modelCount: 1,
      auth: "authenticated",
      freshness: { refreshedAt: null, stale: false },
      actions: [],
    }),
  );
}

/** The per-source catalog entries projected from the roster (one entry per provider, via the bridge). */
export function catalogFromRoster(roster: Roster): Record<string, CatalogEntry[]> {
  const out: Record<string, CatalogEntry[]> = {};
  for (const [sourceId, pm] of Object.entries(roster)) {
    out[sourceId] = [catalogEntryFromProviderModel(sourceId, pm)];
  }
  return out;
}

/**
 * A model's reasoning surface (its supported levels + default) from the roster, so a selection's
 * reasoning can be constrained to what the chosen model actually supports. An unknown source (not in
 * the roster yet, before host.online) has no reasoning surface.
 */
export function reasoningSurfaceOf(
  roster: Roster,
  ref: Pick<ModelRef, "sourceId">,
): ReasoningSurface {
  const pm = roster[ref.sourceId];
  return pm
    ? { levels: pm.reasoningLevels, default: pm.defaultReasoning }
    : { levels: [], default: "off" };
}

/** Source-id -> label and model-id -> label maps for the quick-picker / chooser rows. */
export function rosterLabels(roster: Roster): {
  readonly sourceLabels: Record<string, string>;
  readonly modelLabels: Record<string, string>;
} {
  const sourceLabels: Record<string, string> = {};
  const modelLabels: Record<string, string> = {};
  for (const [sourceId, pm] of Object.entries(roster)) {
    sourceLabels[sourceId] = pm.label;
    modelLabels[pm.model] = pm.label;
  }
  return { sourceLabels, modelLabels };
}

/**
 * The legacy-derived active reference: the current provider+reasoning selection projected to a stable
 * {@link ModelRef}. Used as the active model until the user makes an explicit chooser/quick-pick
 * selection (which persists into ModelPreferences). Null when the roster has no entry for the provider
 * yet (before host.online arrives), so callers fall back to a neutral label.
 */
export function legacyActiveRef(
  roster: Roster,
  provider: string,
  reasoning: string | null,
): ModelRef | null {
  const pm = roster[provider];
  return pm ? modelRefFromProvider(provider, pm.model, reasoning) : null;
}
