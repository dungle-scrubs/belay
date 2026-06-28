import {
  type CatalogEntry,
  decodeModelPreferences,
  EMPTY_PREFERENCES,
  type ModelPreferences,
  type ModelRef,
  modelRefKey,
  type ProviderModel,
  pinModel,
  type QuickPickerGroup,
  quickPickerModels,
  type SourceSummary,
  sameModel,
  selectModel,
  unpinModel,
} from "@trevor/session";
import { useLocalStorageState } from "ahooks";
import { useCallback, useMemo } from "react";
import { legacyActiveRef, reasoningSurfaceOf, rosterLabels } from "@/model-selection";

/**
 * The model-selection state hook (D-065 M3/M6): owns the persisted {@link ModelPreferences} (active /
 * recent / pinned / per-model reasoning) and the read models the split control + full chooser render.
 * The pure projection + selection transitions live in `@/model-selection` and `@trevor/session`; this
 * is the React glue (localStorage persistence + memoized derivations).
 *
 * The ACTIVE model is the persisted `active` ref, falling back to the legacy provider+reasoning
 * selection until the user makes an explicit pick - so the chooser is the source of truth once used,
 * but the existing sidebar provider behavior keeps working through the migration.
 */

const MODEL_PREFS_KEY = "trevor.modelPreferences";

export interface ModelSelection {
  readonly preferences: ModelPreferences;
  /** The active model: the persisted `active` ref, else the legacy provider-derived ref (null before host.online). */
  readonly active: ModelRef | null;
  /** The active model's display label for the split control's left region. */
  readonly activeLabel: string;
  /** The recently-used models, grouped by source, for the quick picker. */
  readonly quickGroups: QuickPickerGroup[];
  readonly sources: readonly SourceSummary[];
  readonly catalogBySource: Readonly<Record<string, readonly CatalogEntry[]>>;
  readonly sourceLabels: Readonly<Record<string, string>>;
  readonly modelLabels: Readonly<Record<string, string>>;
  /** Select a model: clamps its reasoning to the model's surface, records active + recent, persists. */
  readonly select: (ref: ModelRef) => void;
  /** The `modelRefKey`s of the recently-used models, for the chooser's "Recent" preference filter. */
  readonly recentKeys: ReadonlySet<string>;
  /** The `modelRefKey`s of the pinned models, for the chooser's "Pinned" filter + the row pin state. */
  readonly pinnedKeys: ReadonlySet<string>;
  /** Pin or unpin a model (idempotent), persisting the change. */
  readonly togglePin: (ref: ModelRef) => void;
}

export function useModelSelection({
  roster,
  hostSources,
  hostCatalog,
  legacyProvider,
  legacyReasoning,
}: {
  /** The host-announced provider roster (host.online `models`), the pre-catalog fallback. */
  readonly roster: Readonly<Record<string, ProviderModel>>;
  /** The host-owned model SOURCES (host.online `sources`, D-065); preferred once the catalog loads. */
  readonly hostSources: readonly SourceSummary[];
  /** The host-owned per-source catalog (host.online `catalog`, D-065). */
  readonly hostCatalog: Readonly<Record<string, readonly CatalogEntry[]>>;
  /** Today's sidebar provider selection, the active fallback until an explicit chooser pick. */
  readonly legacyProvider: string;
  /** Today's chosen reasoning level for the active provider (null = provider default). */
  readonly legacyReasoning: string | null;
}): ModelSelection {
  const [rawPrefs, setRawPrefs] = useLocalStorageState<ModelPreferences>(MODEL_PREFS_KEY, {
    defaultValue: EMPTY_PREFERENCES,
  });
  // Normalize on every read so a partial/garbled stored object loads to a safe value (decode drops
  // unusable refs) rather than trusting the raw JSON ahooks hands back.
  const preferences = useMemo(() => decodeModelPreferences(rawPrefs), [rawPrefs]);

  // The source/catalog the chooser renders is purely host-owned (real provider types, live model
  // lists, auth state). It is NOT projected from the legacy provider roster: that projection produced
  // a wrong structure (one source per provider, OAuth shown as direct-API, "1 models" each), so when
  // the host has not reported sources the chooser shows an explicit empty state instead of fake data.
  const sources = hostSources;
  const catalogBySource = hostCatalog;
  // Labels merge the roster's curated names (for the active model before/without a host catalog) with
  // the host source/catalog labels, which win when present.
  const { sourceLabels, modelLabels } = useMemo(() => {
    const roster0 = rosterLabels(roster);
    const sl: Record<string, string> = { ...roster0.sourceLabels };
    for (const s of hostSources) {
      sl[s.sourceId] = s.label;
    }
    const ml: Record<string, string> = { ...roster0.modelLabels };
    for (const entries of Object.values(hostCatalog)) {
      for (const e of entries) {
        ml[e.modelId] = e.displayName;
      }
    }
    return { sourceLabels: sl, modelLabels: ml };
  }, [hostSources, hostCatalog, roster]);
  const quickGroups = useMemo(() => quickPickerModels(preferences), [preferences]);

  const legacyRef = useMemo(
    () => legacyActiveRef(roster, legacyProvider, legacyReasoning),
    [roster, legacyProvider, legacyReasoning],
  );
  const active = preferences.active ?? legacyRef;

  const activeLabel = useMemo(() => {
    if (!active) {
      return legacyProvider;
    }
    return modelLabels[active.modelId] ?? sourceLabels[active.sourceId] ?? active.modelId;
  }, [active, modelLabels, sourceLabels, legacyProvider]);

  const select = useCallback(
    (ref: ModelRef) => {
      const surface = reasoningSurfaceOf(roster, ref);
      setRawPrefs((prev) => selectModel(decodeModelPreferences(prev), ref, surface));
    },
    [roster, setRawPrefs],
  );

  const recentKeys = useMemo(
    () => new Set(preferences.recent.map(modelRefKey)),
    [preferences.recent],
  );
  const pinnedKeys = useMemo(
    () => new Set(preferences.pinned.map(modelRefKey)),
    [preferences.pinned],
  );
  const togglePin = useCallback(
    (ref: ModelRef) => {
      setRawPrefs((prev) => {
        const p = decodeModelPreferences(prev);
        return p.pinned.some((r) => sameModel(r, ref)) ? unpinModel(p, ref) : pinModel(p, ref);
      });
    },
    [setRawPrefs],
  );

  return {
    preferences,
    active,
    activeLabel,
    quickGroups,
    sources,
    catalogBySource,
    sourceLabels,
    modelLabels,
    select,
    recentKeys,
    pinnedKeys,
    togglePin,
  };
}
