import {
  type CatalogEntry,
  decodeModelPreferences,
  type ModelPreferences,
  type ModelRef,
  type ProviderModel,
  type SourceSummary,
  selectModel,
} from "@belay/session";
import { useLocalStorageState } from "ahooks";
import { useCallback, useMemo } from "react";
import type { ModelPrefsView } from "@/derive";
import {
  buildModelSelection,
  type ModelSelectionProjection,
  sessionScopedKey,
} from "@/model-selection";

/**
 * The model-selection state hook (D-065 M3/M6; plan 51): owns the BROWSER-LOCAL preferences (active /
 * recent / per-model reasoning) and the read models the split control + full chooser render. The DEFAULT
 * model + FAVORITES (pinned) are host-owned (plan 51): they arrive on `host.online` (injected as
 * `hostModelPrefs`) and are mutated by the caller sending the host command directly - this hook does not
 * proxy those writes. The pure projection + selection transitions live in `@/model-selection` and
 * `@belay/session`; this is the React glue.
 *
 * The ACTIVE model is the persisted `active` ref, falling back to the legacy provider+reasoning
 * selection until the user makes an explicit pick - so the chooser is the source of truth once used,
 * but the existing sidebar provider behavior keeps working through the migration.
 */

/** Per-SESSION model state: the active pick + per-model reasoning (so two open sessions don't fight). */
const MODEL_PREFS_KEY = "belay.modelPreferences";
/** GLOBAL model library: RECENTS only. Recents are usage state (per browser), so they stay local; the
 *  DEFAULT + FAVORITES moved host-side in plan 51 (durable + shared across every session/browser talking
 *  to the host), so they are no longer written here. A pre-plan-51 blob may still carry stale
 *  pinned/default keys; they are NOT migrated - the host announcement is authoritative and overlays them,
 *  so a stale local value can never shadow the host's. */
const GLOBAL_PREFS_KEY = "belay.modelPreferences.global";

type GlobalPrefs = Pick<ModelPreferences, "recent">;
type SessionPrefs = Pick<ModelPreferences, "active" | "reasoningByModel">;

export interface ModelSelection extends ModelSelectionProjection {
  /** Select a model: clamps its reasoning to the model's surface, records active + recent, persists. */
  readonly select: (ref: ModelRef) => void;
}

export function useModelSelection({
  roster,
  hostSources,
  hostCatalog,
  hostModelPrefs,
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
  /** The host-owned default + favorites (host.online `modelPrefs`, plan 51). */
  readonly hostModelPrefs: ModelPrefsView;
  /** Today's sidebar provider selection, the active fallback until an explicit chooser pick. */
  readonly legacyProvider: string;
  /** Today's chosen reasoning level for the active provider (null = provider default). */
  readonly legacyReasoning: string | null;
  /** The open session id; the persisted preferences are scoped to it so they don't leak across
   *  sessions (02.16 D-002). Null (pre-resolve) uses a throwaway key. */
  readonly sessionId: string | null;
}): ModelSelection {
  // Recents are a GLOBAL user library (per browser); active + per-model reasoning are per-session. The
  // default + favorites are host-owned (plan 51), injected via `hostModelPrefs`.
  const [rawGlobal, setRawGlobal] = useLocalStorageState<GlobalPrefs>(GLOBAL_PREFS_KEY, {
    defaultValue: { recent: [] },
  });
  const [rawSession, setRawSession] = useLocalStorageState<SessionPrefs>(
    sessionScopedKey(MODEL_PREFS_KEY, sessionId),
    { defaultValue: { active: null, reasoningByModel: {} } },
  );
  // The browser-local preferences (active/recent/reasoning). Any stale pinned/default in an old blob is
  // ignored here - the host `modelPrefs` is the source of those (overlaid in buildModelSelection).
  const preferences = useMemo(
    () => decodeModelPreferences({ ...rawSession, ...rawGlobal }),
    [rawSession, rawGlobal],
  );

  const selection = useMemo(
    () =>
      buildModelSelection({
        preferences,
        modelPrefs: hostModelPrefs,
        roster,
        hostSources,
        hostCatalog,
        legacyProvider,
        legacyReasoning,
      }),
    [
      preferences,
      hostModelPrefs,
      roster,
      hostSources,
      hostCatalog,
      legacyProvider,
      legacyReasoning,
    ],
  );

  // selectModel touches the per-session active/reasoning + the global recent list only (the default +
  // favorites are host-owned now, so they are never written locally).
  const select = useCallback(
    (ref: ModelRef) => {
      const next = selectModel(preferences, ref, selection.reasoningSurface(ref));
      setRawSession({ active: next.active, reasoningByModel: next.reasoningByModel });
      setRawGlobal({ recent: next.recent });
    },
    [preferences, selection, setRawSession, setRawGlobal],
  );

  return {
    ...selection,
    select,
  };
}
