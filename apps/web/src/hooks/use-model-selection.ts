import {
  type CatalogEntry,
  decodeModelPreferences,
  EMPTY_PREFERENCES,
  type ModelPreferences,
  type ModelRef,
  type ProviderModel,
  pinModel,
  type SourceSummary,
  sameModel,
  selectModel,
  unpinModel,
} from "@trevor/session";
import { useLocalStorageState } from "ahooks";
import { useCallback, useMemo } from "react";
import {
  buildModelSelection,
  type ModelSelectionProjection,
  sessionScopedKey,
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

export interface ModelSelection extends ModelSelectionProjection {
  /** Select a model: clamps its reasoning to the model's surface, records active + recent, persists. */
  readonly select: (ref: ModelRef) => void;
  /** Pin or unpin a model (idempotent), persisting the change. */
  readonly togglePin: (ref: ModelRef) => void;
}

export function useModelSelection({
  roster,
  hostSources,
  hostCatalog,
  legacyProvider,
  legacyReasoning,
  sessionId,
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
  /** The open session id; the persisted preferences are scoped to it so they don't leak across
   *  sessions (02.16 D-002). Null (pre-resolve) uses a throwaway key. */
  readonly sessionId: string | null;
}): ModelSelection {
  const [rawPrefs, setRawPrefs] = useLocalStorageState<ModelPreferences>(
    sessionScopedKey(MODEL_PREFS_KEY, sessionId),
    { defaultValue: EMPTY_PREFERENCES },
  );
  // Normalize on every read so a partial/garbled stored object loads to a safe value (decode drops
  // unusable refs) rather than trusting the raw JSON ahooks hands back.
  const preferences = useMemo(() => decodeModelPreferences(rawPrefs), [rawPrefs]);

  const selection = useMemo(
    () =>
      buildModelSelection({
        preferences,
        roster,
        hostSources,
        hostCatalog,
        legacyProvider,
        legacyReasoning,
      }),
    [preferences, roster, hostSources, hostCatalog, legacyProvider, legacyReasoning],
  );

  const select = useCallback(
    (ref: ModelRef) => {
      const surface = selection.reasoningSurface(ref);
      setRawPrefs((prev) => selectModel(decodeModelPreferences(prev), ref, surface));
    },
    [selection, setRawPrefs],
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
    ...selection,
    select,
    togglePin,
  };
}
