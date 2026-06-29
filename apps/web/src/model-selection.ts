import {
  type CatalogEntry,
  type ModelPreferences,
  type ModelRef,
  modelRefFromProvider,
  modelRefKey,
  type ProviderModel,
  type QuickPickerGroup,
  quickPickerModels,
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
 * Resolves the reasoning level to show/send for a model surface: the stored level if it is still one
 * of the model's `levels`, else the `fallback` (the model's default). The ONE owner of the
 * "stored-level-if-still-valid-else-default" rule, which App previously spelled twice (the sidebar
 * provider reasoning and the active-model reasoning) and could drift between.
 */
export function resolveReasoning(
  levels: readonly string[],
  stored: string | undefined,
  fallback: string,
): string {
  return stored && levels.includes(stored) ? stored : fallback;
}

export interface ModelSelectionProjectionInput {
  readonly preferences: ModelPreferences;
  readonly roster: Roster;
  readonly hostSources: readonly SourceSummary[];
  readonly hostCatalog: Readonly<Record<string, readonly CatalogEntry[]>>;
  readonly legacyProvider: string;
  readonly legacyReasoning: string | null;
}

export interface ModelSelectionProjection {
  readonly preferences: ModelPreferences;
  readonly active: ModelRef | null;
  readonly activeLabel: string;
  readonly quickGroups: QuickPickerGroup[];
  readonly sources: readonly SourceSummary[];
  readonly catalogBySource: Readonly<Record<string, readonly CatalogEntry[]>>;
  readonly sourceLabels: Readonly<Record<string, string>>;
  readonly modelLabels: Readonly<Record<string, string>>;
  readonly recentKeys: ReadonlySet<string>;
  readonly pinnedKeys: ReadonlySet<string>;
  readonly reasoningSurface: (ref: Pick<ModelRef, "sourceId">) => ReasoningSurface;
}

export interface LegacyCatalogBridge {
  readonly sources: readonly SourceSummary[];
  readonly catalogBySource: Readonly<Record<string, readonly CatalogEntry[]>>;
  readonly sourceLabels: Readonly<Record<string, string>>;
  readonly modelLabels: Readonly<Record<string, string>>;
  readonly legacyActiveRef: (provider: string, reasoning: string | null) => ModelRef | null;
  readonly reasoningSurface: (ref: Pick<ModelRef, "sourceId">) => ReasoningSurface;
}

export function buildModelSelection({
  preferences,
  roster,
  hostSources,
  hostCatalog,
  legacyProvider,
  legacyReasoning,
}: ModelSelectionProjectionInput): ModelSelectionProjection {
  const catalog = legacyToCatalog(roster, hostSources, hostCatalog);

  const legacyRef = catalog.legacyActiveRef(legacyProvider, legacyReasoning);
  const active = preferences.active ?? legacyRef;
  const activeLabel = active
    ? (catalog.modelLabels[active.modelId] ??
      catalog.sourceLabels[active.sourceId] ??
      active.modelId)
    : legacyProvider;

  return {
    preferences,
    active,
    activeLabel,
    quickGroups: quickPickerModels(preferences),
    sources: catalog.sources,
    catalogBySource: catalog.catalogBySource,
    sourceLabels: catalog.sourceLabels,
    modelLabels: catalog.modelLabels,
    recentKeys: new Set(preferences.recent.map(modelRefKey)),
    pinnedKeys: new Set(preferences.pinned.map(modelRefKey)),
    reasoningSurface: catalog.reasoningSurface,
  };
}

export function legacyToCatalog(
  roster: Roster,
  hostSources: readonly SourceSummary[],
  hostCatalog: Readonly<Record<string, readonly CatalogEntry[]>>,
): LegacyCatalogBridge {
  const sourceLabels: Record<string, string> = {};
  const modelLabels: Record<string, string> = {};
  for (const [sourceId, pm] of Object.entries(roster)) {
    sourceLabels[sourceId] = pm.label;
    modelLabels[pm.model] = pm.label;
  }

  for (const s of hostSources) {
    sourceLabels[s.sourceId] = s.label;
  }
  for (const entries of Object.values(hostCatalog)) {
    for (const e of entries) {
      modelLabels[e.modelId] = e.displayName;
    }
  }

  return {
    sources: hostSources,
    catalogBySource: hostCatalog,
    sourceLabels,
    modelLabels,
    legacyActiveRef(provider, reasoning) {
      const pm = roster[provider];
      return pm ? modelRefFromProvider(provider, pm.model, reasoning) : null;
    },
    reasoningSurface(ref) {
      const pm = roster[ref.sourceId];
      return pm
        ? { levels: pm.reasoningLevels, default: pm.defaultReasoning }
        : { levels: [], default: "off" };
    },
  };
}
