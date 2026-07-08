import {
  type CatalogEntry,
  catalogEntryFor,
  constrainReasoning,
  type ModelRef,
  modelRefFromProvider,
  type ProviderModel,
  type SourceSummary,
} from "@trevor/session";
import { useLocalStorageState } from "ahooks";
import { useCallback, useEffect } from "react";
import type { ModelPrefsView } from "@/derive";
import { useModelSelection } from "@/hooks/use-model-selection";
import { activeModelLabel, resolveReasoning, sessionScopedKey } from "@/model-selection";

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
}) {
  // HMR resilience: the last known-good model for this session, persisted whenever the host roster
  // resolves a real one. A Vite HMR can momentarily blank the in-memory host.online fold (events state
  // resets and re-replays), and during that window the roster lacks the active provider. Without this,
  // the model field degenerates to the provider id and reasoning to "off" - an invalid ref that blocks
  // prompting. The recovered ref keeps the real modelId + reasoning until host.online re-folds.
  const [lastKnownModel, setLastKnownModel] = useLocalStorageState<ModelRef>(
    sessionScopedKey("trevor.lastModel", sessionId),
    { defaultValue: undefined },
  );
  const firstAnnouncedProvider = Object.keys(hostModels)[0];
  const activeProvider =
    provider ?? lastUserModel?.provider ?? hostDefault ?? firstAnnouncedProvider ?? "default";
  const seededReasoning =
    lastUserModel?.provider === activeProvider ? lastUserModel.reasoning : undefined;
  const rosterMeta = hostModels[activeProvider];
  // When the roster lacks the active provider, recover the last known-good model so the model field
  // keeps its real modelId and reasoning instead of degenerating to the provider id + "off".
  const recoveredModel =
    lastKnownModel && lastKnownModel.sourceId === activeProvider ? lastKnownModel : undefined;
  const modelMeta = rosterMeta ?? {
    label: recoveredModel?.modelId ?? activeProvider,
    model: recoveredModel?.modelId ?? activeProvider,
    reasoningLevels: recoveredModel?.reasoning ? [recoveredModel.reasoning] : [],
    defaultReasoning: recoveredModel?.reasoning ?? "off",
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
  });

  // The initial-model pick (plan 51 D-005, the "reset to qwen" fix): an explicit per-session `active`
  // wins; otherwise the user's host-owned DEFAULT drives a fresh session; only then the legacy fallback
  // (qwen). `selection.active` cannot be used here - it already collapses `active ?? legacyRef`, so it is
  // never null for a fresh session (it is qwen) and would short-circuit the default. `selection.preferences`
  // is the EFFECTIVE preferences with the host default overlaid.
  const sendModel = selection.preferences.active ?? selection.preferences.default ?? activeModelRef;
  // Persist the last known-good model whenever the roster resolves a real one (write only on change),
  // so a later empty roster (HMR) recovers a valid ref.
  useEffect(() => {
    if (
      rosterMeta &&
      sendModel &&
      (lastKnownModel?.sourceId !== sendModel.sourceId ||
        lastKnownModel?.modelId !== sendModel.modelId ||
        (lastKnownModel?.reasoning ?? null) !== (sendModel.reasoning ?? null))
    ) {
      setLastKnownModel(sendModel);
    }
  }, [rosterMeta, sendModel, lastKnownModel, setLastKnownModel]);
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
