import {
  type CatalogEntry,
  decodeModelPreferences,
  EMPTY_PREFERENCES,
  type ModelPreferences,
  type ModelRef,
  type ProviderModel,
  type QuickPickerGroup,
  quickPickerModels,
  type SourceSummary,
  selectModel,
} from "@trevor/session";
import { useLocalStorageState } from "ahooks";
import { useCallback, useMemo } from "react";
import {
  catalogFromRoster,
  legacyActiveRef,
  reasoningSurfaceOf,
  rosterLabels,
  sourcesFromRoster,
} from "@/model-selection";

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

  // Prefer the host-owned source/catalog read model (real types, live model lists, auth state); fall
  // back to projecting the legacy provider roster only until the host's first catalog load lands.
  const sources = useMemo(
    () => (hostSources.length > 0 ? hostSources : sourcesFromRoster(roster)),
    [hostSources, roster],
  );
  const catalogBySource = useMemo(
    () => (Object.keys(hostCatalog).length > 0 ? hostCatalog : catalogFromRoster(roster)),
    [hostCatalog, roster],
  );
  const { sourceLabels, modelLabels } = useMemo(() => {
    if (hostSources.length > 0 || Object.keys(hostCatalog).length > 0) {
      const sl: Record<string, string> = {};
      for (const s of sources) {
        sl[s.sourceId] = s.label;
      }
      const ml: Record<string, string> = {};
      for (const entries of Object.values(catalogBySource)) {
        for (const e of entries) {
          ml[e.modelId] = e.displayName;
        }
      }
      return { sourceLabels: sl, modelLabels: ml };
    }
    return rosterLabels(roster);
  }, [hostSources, hostCatalog, sources, catalogBySource, roster]);
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
  };
}
