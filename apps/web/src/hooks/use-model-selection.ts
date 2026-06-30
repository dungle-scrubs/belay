import {
  type CatalogEntry,
  decodeModelPreferences,
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

/** Per-SESSION model state: the active pick + per-model reasoning (so two open sessions don't fight). */
const MODEL_PREFS_KEY = "trevor.modelPreferences";
/** GLOBAL model library: recents / pinned / default. These are user preferences, not conversation
 *  state, so they're shared across sessions - a fresh or handed-off session shows the models you
 *  actually use instead of an empty picker (the per-session split lost them before). */
const GLOBAL_PREFS_KEY = "trevor.modelPreferences.global";

type GlobalPrefs = Pick<ModelPreferences, "recent" | "pinned" | "default">;
type SessionPrefs = Pick<ModelPreferences, "active" | "reasoningByModel">;

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
  // recents / pinned / default are a GLOBAL user library; active + per-model reasoning are per-session.
  const [rawGlobal, setRawGlobal] = useLocalStorageState<GlobalPrefs>(GLOBAL_PREFS_KEY, {
    defaultValue: { recent: [], pinned: [], default: null },
  });
  const [rawSession, setRawSession] = useLocalStorageState<SessionPrefs>(
    sessionScopedKey(MODEL_PREFS_KEY, sessionId),
    { defaultValue: { active: null, reasoningByModel: {} } },
  );
  // Normalize the merged view on every read (decode drops unusable refs). Global wins on the shared
  // keys, so a stale recent/pinned left in an old per-session blob can't shadow the global library.
  const preferences = useMemo(
    () => decodeModelPreferences({ ...rawSession, ...rawGlobal }),
    [rawSession, rawGlobal],
  );

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

  // selectModel touches both stores (active is per-session; recent + default are global), so compute
  // the next prefs once from the merged view and split it back into the two backings.
  const select = useCallback(
    (ref: ModelRef) => {
      const next = selectModel(preferences, ref, selection.reasoningSurface(ref));
      setRawSession({ active: next.active, reasoningByModel: next.reasoningByModel });
      setRawGlobal({ recent: next.recent, pinned: next.pinned, default: next.default });
    },
    [preferences, selection, setRawSession, setRawGlobal],
  );

  const togglePin = useCallback(
    (ref: ModelRef) => {
      const next = preferences.pinned.some((r) => sameModel(r, ref))
        ? unpinModel(preferences, ref)
        : pinModel(preferences, ref);
      setRawGlobal({ recent: next.recent, pinned: next.pinned, default: next.default });
    },
    [preferences, setRawGlobal],
  );

  return {
    ...selection,
    select,
    togglePin,
  };
}
