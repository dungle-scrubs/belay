import {
  type CatalogEntry,
  catalogEntryFor,
  constrainReasoning,
  type ModelRef,
  modelRefFromProvider,
  type ProviderModel,
  type SourceSummary,
} from "@trevor/session";
import { useCallback } from "react";
import type { ModelPrefsView } from "@/derive";
import { useModelSelection } from "@/hooks/use-model-selection";
import { activeModelLabel, resolveReasoning } from "@/model-selection";

type LastUserModel = {
  readonly provider?: string;
  readonly reasoning?: string;
} | null;

export function useActiveModel({
  hostModels,
  hostSources,
  hostCatalog,
  hostModelPrefs,
  provider,
  setProvider,
  reasoningMap,
  setReasoningMap,
  hostDefault,
  lastUserModel,
  sessionId,
  activeRunId,
  switchModel,
  setModelDefault,
  toggleModelFavorite,
}: {
  readonly hostModels: Readonly<Record<string, ProviderModel>>;
  readonly hostSources: readonly SourceSummary[];
  readonly hostCatalog: Readonly<Record<string, readonly CatalogEntry[]>>;
  /** The host-owned default + favorites (host.online `modelPrefs`, plan 51). */
  readonly hostModelPrefs: ModelPrefsView;
  readonly provider: string | undefined;
  readonly setProvider: (provider: string) => void;
  readonly reasoningMap: Readonly<Record<string, string>> | undefined;
  readonly setReasoningMap: (map: Record<string, string>) => void;
  readonly hostDefault: string | undefined;
  readonly lastUserModel: LastUserModel;
  readonly sessionId: string | null;
  readonly activeRunId: string | null;
  readonly switchModel: (runId: string, model: ModelRef) => void | Promise<void>;
  /** Send the host set-default command (plan 51). */
  readonly setModelDefault: (ref: ModelRef) => void;
  /** Send the host toggle-favorite command (plan 51). */
  readonly toggleModelFavorite: (ref: ModelRef) => void;
}) {
  const firstAnnouncedProvider = Object.keys(hostModels)[0];
  const activeProvider =
    provider ?? lastUserModel?.provider ?? hostDefault ?? firstAnnouncedProvider ?? "default";
  const seededReasoning =
    lastUserModel?.provider === activeProvider ? lastUserModel.reasoning : undefined;
  const modelMeta = hostModels[activeProvider] ?? {
    label: activeProvider,
    model: activeProvider,
    reasoningLevels: [],
    defaultReasoning: "off",
    kind: "local" as const,
  };
  const reasoning = resolveReasoning(
    modelMeta.reasoningLevels,
    reasoningMap?.[activeProvider] ?? seededReasoning,
    modelMeta.defaultReasoning,
  );
  const setReasoning = useCallback(
    (level: string) => setReasoningMap({ ...(reasoningMap ?? {}), [activeProvider]: level }),
    [activeProvider, reasoningMap, setReasoningMap],
  );
  const activeModelRef = modelRefFromProvider(activeProvider, modelMeta.model, reasoning || null);

  const selection = useModelSelection({
    roster: hostModels,
    hostSources,
    hostCatalog,
    hostModelPrefs,
    legacyProvider: activeProvider,
    legacyReasoning: reasoning || null,
    sessionId,
    setDefaultCommand: setModelDefault,
    toggleFavoriteCommand: toggleModelFavorite,
  });

  // The initial-model pick (plan 51 D-005, the "reset to qwen" fix): an explicit per-session `active`
  // wins; otherwise the user's host-owned DEFAULT drives a fresh session; only then the legacy fallback
  // (qwen). `selection.active` cannot be used here - it already collapses `active ?? legacyRef`, so it is
  // never null for a fresh session (it is qwen) and would short-circuit the default. `selection.preferences`
  // is the EFFECTIVE preferences with the host default overlaid.
  const sendModel = selection.preferences.active ?? selection.preferences.default ?? activeModelRef;
  const activeEntry = catalogEntryFor(selection.catalogBySource, sendModel);
  const activeLabel = activeModelLabel({
    entry: activeEntry,
    registeredProvider: Boolean(hostModels[activeProvider]),
    rosterLabel: modelMeta.label,
    selectionLabel: selection.activeLabel,
  });
  const activeReasoningLevels =
    activeEntry && activeEntry.reasoningLevels.length > 0
      ? activeEntry.reasoningLevels
      : modelMeta.reasoningLevels;
  const activeReasoning = resolveReasoning(
    activeReasoningLevels,
    reasoningMap?.[activeProvider] ?? seededReasoning,
    activeEntry?.defaultReasoning ?? modelMeta.defaultReasoning,
  );
  const sendModelRef: ModelRef = {
    sourceId: sendModel.sourceId,
    modelId: sendModel.modelId,
    reasoning: activeReasoning || null,
  };

  const onSelectModel = useCallback(
    (ref: ModelRef) => {
      const carried = constrainReasoning(
        selection.reasoningSurface(ref),
        activeReasoning || ref.reasoning,
      );
      const target: ModelRef = { ...ref, reasoning: carried };
      selection.select(target);
      setProvider(ref.sourceId);
      if (carried != null) {
        setReasoningMap({ ...(reasoningMap ?? {}), [ref.sourceId]: carried });
      }
      if (activeRunId) {
        void switchModel(activeRunId, target);
      }
    },
    [
      activeReasoning,
      activeRunId,
      reasoningMap,
      selection,
      setProvider,
      setReasoningMap,
      switchModel,
    ],
  );

  return {
    activeProvider,
    reasoning,
    setReasoning,
    selection,
    sendModel,
    activeLabel,
    activeReasoningLevels,
    activeReasoning,
    sendModelRef,
    onSelectModel,
  };
}
