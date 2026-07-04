import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CatalogEntry,
  filterCatalog,
  type ModelRef,
  modelRefKey,
  projectSourceState,
  type SourceAction,
  type SourceSummary,
  type SourceType,
  sameModel,
} from "@trevor/session";
import {
  ArrowLeft,
  BadgeCheck,
  Check,
  ChevronRight,
  Cpu,
  KeyRound,
  Network,
  Search,
  Sparkles,
  Star,
  StarOff,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RowContextMenu, type RowMenuItem } from "@/components/ui/row-context-menu";
import { fmtCtx } from "@/derive";
import { cn } from "@/lib/utils";
import { sortModelsByPreference } from "@/model-selection";
import {
  type DeviceCodeFlow,
  needsAuthPanel,
  SOURCE_ACTION_META,
  SourceAuthPanel,
} from "./source-auth-panel";

/**
 * The full model chooser (D-065 M2): the model-source + catalog browser that takes over the
 * transcript + prompt space (the sidebars stay visible) instead of the small sidebar popup. Two views
 * - a source OVERVIEW grouped by family (local runtimes, cloud subscriptions, direct API, gateway
 * catalogs) and a per-source DETAIL with search + capability filters + model rows. Presentational over
 * the host-owned read models (`SourceSummary` / `CatalogEntry`): it never hardcodes a model list, and
 * it renders source status / auth / freshness exactly as the host reports. Container-query driven, so
 * it adapts to the space LEFT AFTER the sidebars, not the viewport width.
 *
 * Built Storybook-first: navigation (overview <-> detail) and the detail search/filter are local
 * state; the data and the selection callback come from props. M4 swaps the in-memory `catalogBySource`
 * for the host-backed paged query; M6 layers reasoning onto the selected `ModelRef`.
 */

/** The source families, in render order, with their section headings. */
const SECTIONS: readonly { readonly type: SourceType; readonly label: string }[] = [
  { type: "local", label: "Local runtimes" },
  { type: "oauth", label: "Cloud subscriptions" },
  { type: "api-key", label: "Direct API" },
  { type: "gateway", label: "Gateway catalogs" },
];

const SECTION_ICON: Record<SourceType, typeof Cpu> = {
  local: Cpu,
  oauth: Sparkles,
  "api-key": KeyRound,
  gateway: Network,
};

/**
 * A pill toggle (the Configured-only header toggle + the capability/preference filter chips). `active`
 * flips the filled vs outline branch; `className` carries the per-use extras (`shrink-0`, `capitalize`)
 * so the shared recipe + active/inactive colors live in one place.
 */
function FilterChip({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-card",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The first action a source offers, or null - the chooser renders what the host says, never invents. */
function primaryAction(source: SourceSummary): SourceAction | null {
  return source.actions[0] ?? null;
}

export interface ModelChooserProps {
  readonly sources: readonly SourceSummary[];
  /**
   * The in-memory catalog entries per source id, filtered client-side for M2. M4 replaces this with a
   * host-backed paged query so a giant gateway catalog never ships whole.
   */
  readonly catalogBySource: Readonly<Record<string, readonly CatalogEntry[]>>;
  /** The currently-selected model, marked in the list. */
  readonly activeModel?: ModelRef | null;
  /** True while the source list is still loading (shows a skeleton instead of an empty state). */
  readonly loading?: boolean;
  readonly onSelectModel: (ref: ModelRef) => void;
  /** Invoked from the source-detail auth/setup action (host-owned flows). */
  readonly onSourceAction?: (sourceId: string, action: SourceAction) => void;
  /** An in-progress device/provider-code flow (host-started), shown in its source's detail. */
  readonly deviceCode?: DeviceCodeFlow | null;
  /** The source the device-code flow belongs to, so it shows only on that source's detail. */
  readonly deviceCodeSourceId?: string;
  /** Submit a non-key provider code for the open source's device-code flow. */
  readonly onSubmitCode?: (code: string) => void;
  /** Open directly on a source's detail view (deep link / Storybook); defaults to the overview. */
  readonly initialSourceId?: string;
  /** `modelRefKey`s of recently-used models (D-065 M4 "Recent" preference filter); omit to hide it. */
  readonly recentKeys?: ReadonlySet<string>;
  /** `modelRefKey`s of pinned models (D-065 M4 "Pinned" filter + row pin state); omit to hide pinning. */
  readonly pinnedKeys?: ReadonlySet<string>;
  /** Pin/unpin a model from its row star; omit to hide the pin affordance entirely. */
  readonly onTogglePin?: (ref: ModelRef) => void;
  /** The `modelRefKey` of the host DEFAULT model (plan 51): marks the default row + its source with a
   *  distinct BadgeCheck glyph. Null / omitted when there is no default. */
  readonly defaultKey?: string | null;
  /** Set a model as the default from its row's right-click menu (plan 51); omit to hide the affordance. */
  readonly onSetDefault?: (ref: ModelRef) => void;
  readonly className?: string;
}

/** The capability filter chips the detail view exposes (entry-derivable: from the CatalogEntry alone). */
const CAPABILITY_FILTERS = ["tools", "vision", "reasoning"] as const;
type CapabilityFilter = (typeof CAPABILITY_FILTERS)[number];

/** The preference-driven filter chips (D-065 M4): membership in the user's recent/pinned sets, not an
 *  entry capability. Shown only when the chooser is given the corresponding preference data. */
const PREFERENCE_FILTERS = ["recent", "pinned"] as const;
type PreferenceFilter = (typeof PREFERENCE_FILTERS)[number];
type ChooserFilter = CapabilityFilter | PreferenceFilter;

const NO_FILTERS: Record<ChooserFilter, boolean> = {
  tools: false,
  vision: false,
  reasoning: false,
  recent: false,
  pinned: false,
};

export function ModelChooser({
  sources,
  catalogBySource,
  activeModel,
  loading,
  onSelectModel,
  onSourceAction,
  deviceCode,
  deviceCodeSourceId,
  onSubmitCode,
  initialSourceId,
  recentKeys,
  pinnedKeys,
  onTogglePin,
  defaultKey,
  onSetDefault,
  className,
}: ModelChooserProps) {
  const [openSourceId, setOpenSourceId] = useState<string | null>(initialSourceId ?? null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<ChooserFilter, boolean>>(NO_FILTERS);

  const openSource = openSourceId
    ? (sources.find((s) => s.sourceId === openSourceId) ?? null)
    : null;

  // The source that holds the default model, for the source-level default glyph (plan 51 D-003). Prefer a
  // catalog match (robust to any id shape); fall back to the ref-key prefix (`sourceId/modelId`) when the
  // source's catalog has not loaded yet (a source id carries no "/").
  const defaultSourceId = useMemo(() => {
    if (!defaultKey) {
      return null;
    }
    for (const [sid, entries] of Object.entries(catalogBySource)) {
      if (entries.some((e) => modelRefKey(e) === defaultKey)) {
        return sid;
      }
    }
    const slash = defaultKey.indexOf("/");
    return slash > 0 ? defaultKey.slice(0, slash) : null;
  }, [catalogBySource, defaultKey]);

  return (
    <section
      aria-label="Model chooser"
      className={cn("@container flex min-h-0 flex-col bg-background text-foreground", className)}
    >
      {openSource ? (
        <SourceDetail
          source={openSource}
          entries={catalogBySource[openSource.sourceId] ?? []}
          search={search}
          filters={filters}
          activeModel={activeModel}
          recentKeys={recentKeys}
          pinnedKeys={pinnedKeys}
          onTogglePin={onTogglePin}
          defaultKey={defaultKey}
          onSetDefault={onSetDefault}
          onBack={() => {
            setOpenSourceId(null);
            setSearch("");
            setFilters(NO_FILTERS);
          }}
          onSearch={setSearch}
          onToggleFilter={(f) => setFilters((prev) => ({ ...prev, [f]: !prev[f] }))}
          onSelectModel={onSelectModel}
          onSourceAction={onSourceAction}
          deviceCode={deviceCodeSourceId === openSource.sourceId ? deviceCode : null}
          onSubmitCode={onSubmitCode}
        />
      ) : (
        <SourceOverview
          sources={sources}
          loading={loading}
          defaultSourceId={defaultSourceId}
          onOpenSource={(id) => {
            setOpenSourceId(id);
            setSearch("");
          }}
        />
      )}
    </section>
  );
}

/** The grouped source overview: one section per family, each with its selectable/needs-attention rows. */
function SourceOverview({
  sources,
  loading,
  defaultSourceId,
  onOpenSource,
}: {
  sources: readonly SourceSummary[];
  loading?: boolean;
  /** The source id that holds the default model, marked with the default glyph (plan 51 D-003). */
  defaultSourceId?: string | null;
  onOpenSource: (sourceId: string) => void;
}) {
  // "Configured only" hides sources that still need auth/setup. The toggle only appears when there is
  // something to hide, so an all-configured overview never carries a no-op control.
  const [configuredOnly, setConfiguredOnly] = useState(false);
  const needsSetupCount = sources.filter((s) => projectSourceState(s).needsAttention).length;
  const visible =
    configuredOnly && needsSetupCount > 0
      ? sources.filter((s) => !projectSourceState(s).needsAttention)
      : sources;

  if (loading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading sources"
        className="flex flex-1 flex-col gap-2 p-4"
      >
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-md bg-muted/40" />
        ))}
      </div>
    );
  }
  if (sources.length === 0) {
    return (
      <div className="flex flex-1 flex-col gap-2 p-6 text-sm text-muted-foreground">
        <p>The host has not reported any model sources yet.</p>
        <p>
          Sources come from the running host. If one is connected, it may still be starting up - if
          this persists, restart the host so it reports its catalog. Otherwise configure a source: a
          local runtime, a subscription sign-in, or an API key.
        </p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">Choose a model</h2>
          <p className="text-sm text-muted-foreground">
            Pick a source to browse its models. Sources and their status are reported by the host.
          </p>
        </div>
        {needsSetupCount > 0 ? (
          <FilterChip
            active={configuredOnly}
            onClick={() => setConfiguredOnly((on) => !on)}
            className="shrink-0"
          >
            Configured only
          </FilterChip>
        ) : null}
      </header>
      {SECTIONS.map(({ type, label }) => {
        const rows = visible.filter((s) => s.type === type);
        if (rows.length === 0) {
          return null;
        }
        const Icon = SECTION_ICON[type];
        return (
          <section key={type} aria-label={label} className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-label tracking-wider text-muted-foreground">
              <Icon className="size-3.5" />
              {label}
            </h3>
            <div className="grid grid-cols-1 gap-2 @lg:grid-cols-2 @3xl:grid-cols-3">
              {rows.map((source) => (
                <SourceRow
                  key={source.sourceId}
                  source={source}
                  isDefault={source.sourceId === defaultSourceId}
                  onOpen={onOpenSource}
                />
              ))}
            </div>
          </section>
        );
      })}
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Every source needs setup. Turn off "Configured only" to sign in or add a key.
        </p>
      ) : null}
    </div>
  );
}

/** One source row: label, host status summary, model count, the available action, and a click-through. A
 *  source that holds the default model carries the BadgeCheck default glyph beside its label (plan 51). */
function SourceRow({
  source,
  isDefault,
  onOpen,
}: {
  source: SourceSummary;
  isDefault?: boolean;
  onOpen: (sourceId: string) => void;
}) {
  const state = projectSourceState(source);
  const action = primaryAction(source);
  return (
    <button
      type="button"
      onClick={() => onOpen(source.sourceId)}
      aria-label={`Open ${source.label}`}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
        state.needsAttention
          ? "border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10"
          : "border-border bg-card hover:bg-card/70",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{source.label}</span>
          {isDefault ? (
            <BadgeCheck
              aria-label="Holds the default model"
              className="size-3.5 shrink-0 text-primary"
            />
          ) : null}
        </span>
        <span
          className={cn(
            "truncate text-xs",
            state.needsAttention ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
          )}
        >
          {state.summary}
        </span>
      </span>
      {action ? (
        <Badge variant="outline" className="shrink-0">
          {SOURCE_ACTION_META[action].label}
        </Badge>
      ) : null}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

/** The per-source detail: identity + status + auth action, search, capability filters, and model rows. */
function SourceDetail({
  source,
  entries,
  search,
  filters,
  activeModel,
  recentKeys,
  pinnedKeys,
  onTogglePin,
  defaultKey,
  onSetDefault,
  onBack,
  onSearch,
  onToggleFilter,
  onSelectModel,
  onSourceAction,
  deviceCode,
  onSubmitCode,
}: {
  source: SourceSummary;
  entries: readonly CatalogEntry[];
  search: string;
  filters: Record<ChooserFilter, boolean>;
  activeModel?: ModelRef | null;
  recentKeys?: ReadonlySet<string>;
  pinnedKeys?: ReadonlySet<string>;
  onTogglePin?: (ref: ModelRef) => void;
  defaultKey?: string | null;
  onSetDefault?: (ref: ModelRef) => void;
  onBack: () => void;
  onSearch: (text: string) => void;
  onToggleFilter: (f: ChooserFilter) => void;
  onSelectModel: (ref: ModelRef) => void;
  onSourceAction?: (sourceId: string, action: SourceAction) => void;
  deviceCode?: DeviceCodeFlow | null;
  onSubmitCode?: (code: string) => void;
}) {
  const state = projectSourceState(source);
  const action = primaryAction(source);
  const showAuth = needsAuthPanel(source, deviceCode);
  // Preference chips appear only when the chooser was given that data (recent set / a pin handler).
  const prefChips: PreferenceFilter[] = [
    ...(recentKeys ? (["recent"] as const) : []),
    ...(onTogglePin ? (["pinned"] as const) : []),
  ];

  // The FULL filtered set (no page cap), so a large gateway catalog (OpenRouter, 256+) is browsable;
  // ModelList virtualizes it when it is large. Capability + text filters run first (entry-derivable),
  // then the preference filters (membership in the recent/pinned sets) are layered on, then the rows are
  // auto-sorted default -> favorites -> rest (plan 51 D-004) so the preferred models surface first.
  const matched = useMemo(() => {
    const base = filterCatalog(entries, {
      text: search,
      filters: {
        tools: filters.tools || undefined,
        vision: filters.vision || undefined,
        reasoning: filters.reasoning || undefined,
      },
    });
    const filtered = base.filter((e) => {
      const key = modelRefKey(e);
      if (filters.recent && !(recentKeys?.has(key) ?? false)) {
        return false;
      }
      if (filters.pinned && !(pinnedKeys?.has(key) ?? false)) {
        return false;
      }
      return true;
    });
    return sortModelsByPreference(filtered, {
      defaultKey: defaultKey ?? null,
      pinnedKeys: pinnedKeys ?? new Set(),
    });
  }, [entries, search, filters, recentKeys, pinnedKeys, defaultKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-3 border-b border-border p-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to sources">
            <ArrowLeft />
          </Button>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-base font-medium">{source.label}</span>
            <span className="truncate text-xs text-muted-foreground">{state.summary}</span>
          </span>
          {action && !showAuth ? (
            <Button
              variant={state.needsAttention ? "default" : "outline"}
              size="sm"
              onClick={() => onSourceAction?.(source.sourceId, action)}
            >
              {SOURCE_ACTION_META[action].label}
            </Button>
          ) : null}
        </div>
        <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-transparent px-2.5">
          <Search className="size-4 shrink-0 opacity-50" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={`Search ${source.label} models`}
            aria-label="Search models"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[...CAPABILITY_FILTERS, ...prefChips].map((f) => (
            <FilterChip
              key={f}
              active={filters[f]}
              onClick={() => onToggleFilter(f)}
              className="capitalize"
            >
              {f}
            </FilterChip>
          ))}
        </div>
      </header>

      {showAuth ? (
        <SourceAuthPanel
          source={source}
          deviceCode={deviceCode}
          onAction={(a) => onSourceAction?.(source.sourceId, a)}
          onSubmitCode={onSubmitCode}
          className="m-3 mb-0 shrink-0"
        />
      ) : null}

      {matched.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">
          {entries.length === 0
            ? source.status === "needs-auth"
              ? "Sign in above to load this source's models."
              : "This source has no models available."
            : "No models match your search and filters."}
        </p>
      ) : (
        <ModelList
          entries={matched}
          activeModel={activeModel}
          pinnedKeys={pinnedKeys}
          onTogglePin={onTogglePin}
          defaultKey={defaultKey}
          onSetDefault={onSetDefault}
          onSelectModel={onSelectModel}
        />
      )}
    </div>
  );
}

/** Above this many models the list is virtualized; smaller lists render fully (jsdom-test friendly). */
const VIRTUALIZE_OVER = 80;

/**
 * The per-source model list. It renders every matched entry; for a large gateway catalog (OpenRouter)
 * it virtualizes so hundreds of rows stay smooth, while a small source renders its handful of rows
 * directly. `measureElement` keeps the virtual rows correctly sized despite variable row height.
 */
function ModelList({
  entries,
  activeModel,
  pinnedKeys,
  onTogglePin,
  defaultKey,
  onSetDefault,
  onSelectModel,
}: {
  entries: readonly CatalogEntry[];
  activeModel?: ModelRef | null;
  pinnedKeys?: ReadonlySet<string>;
  onTogglePin?: (ref: ModelRef) => void;
  defaultKey?: string | null;
  onSetDefault?: (ref: ModelRef) => void;
  onSelectModel: (ref: ModelRef) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The right-click menu (plan 51 D-002): its cursor position + the row's ref + whether that row is
  // already a favorite (so the item reads Add vs Remove). Null when closed. Only wired when the chooser
  // was given a default/favorite handler (Storybook stays presentational).
  const [menu, setMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly ref: ModelRef;
    readonly label: string;
    readonly pinned: boolean;
  } | null>(null);
  const hasMenu = Boolean(onSetDefault || onTogglePin);
  const virtualize = entries.length > VIRTUALIZE_OVER;
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 12,
    enabled: virtualize,
  });
  const refOf = (entry: CatalogEntry): ModelRef => ({
    sourceId: entry.sourceId,
    modelId: entry.modelId,
    reasoning: null,
  });
  const rowOf = (entry: CatalogEntry) => {
    const pinned = pinnedKeys?.has(modelRefKey(entry)) ?? false;
    return (
      <ModelRow
        entry={entry}
        selected={activeModel != null && sameModel(activeModel, entry)}
        pinned={pinned}
        isDefault={defaultKey != null && modelRefKey(entry) === defaultKey}
        onSelect={() => onSelectModel(refOf(entry))}
        onTogglePin={onTogglePin ? () => onTogglePin(refOf(entry)) : undefined}
        onContextMenu={
          hasMenu
            ? (e) => {
                e.preventDefault();
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  ref: refOf(entry),
                  label: entry.displayName,
                  pinned,
                });
              }
            : undefined
        }
      />
    );
  };
  const menuItems: RowMenuItem[] = menu
    ? [
        ...(onSetDefault
          ? [
              {
                label: "Set as default",
                icon: BadgeCheck,
                onSelect: () => onSetDefault(menu.ref),
              },
            ]
          : []),
        ...(onTogglePin
          ? [
              {
                label: menu.pinned ? "Remove from favorites" : "Add to favorites",
                icon: menu.pinned ? StarOff : Star,
                onSelect: () => onTogglePin(menu.ref),
              },
            ]
          : []),
      ]
    : [];
  return (
    <>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {virtualize ? (
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = entries[item.index];
              if (!entry) {
                return null;
              }
              return (
                <div
                  key={entry.modelId}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute top-0 left-0 w-full pb-1"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {rowOf(entry)}
                </div>
              );
            })}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {entries.map((entry) => (
              <li key={entry.modelId}>{rowOf(entry)}</li>
            ))}
          </ul>
        )}
      </div>
      {menu ? (
        <RowContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
    </>
  );
}

/**
 * One catalog model row: name, capability tags, context length, cost tier, and three SEPARABLE state
 * glyphs (plan 51 D-002) - a BadgeCheck when it is the default, a selected Check, and a pin Star (when
 * pinning is enabled). The select target and the pin toggle are SIBLING buttons (never nested), so the
 * row stays valid + accessible; the pin star reveals on hover and stays lit when set. The default glyph
 * sits inline by the name (out of the way of the right-edge Check/Star, so default+selected+pinned all
 * show at once). A right-click on the row WRAPPER opens the context menu (Set as default / favorite),
 * a progressive enhancement that never fights the row's nested buttons.
 */
function ModelRow({
  entry,
  selected,
  pinned,
  isDefault,
  onSelect,
  onTogglePin,
  onContextMenu,
}: {
  entry: CatalogEntry;
  selected: boolean;
  pinned: boolean;
  isDefault?: boolean;
  onSelect: () => void;
  onTogglePin?: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the row's controls are its button children; onContextMenu is a progressive right-click enhancement over the wrapper.
    <div
      onContextMenu={onContextMenu}
      className={cn(
        "group flex w-full items-center rounded-md transition-colors",
        selected ? "bg-primary/10" : "hover:bg-card",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`Select ${entry.displayName}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{entry.displayName}</span>
            {isDefault ? (
              <BadgeCheck
                aria-label={`${entry.displayName} is the default`}
                className="size-4 shrink-0 text-primary"
              />
            ) : null}
            {entry.freshness.stale ? (
              <span className="shrink-0 text-label tracking-wider text-amber-600 dark:text-amber-400">
                stale
              </span>
            ) : null}
          </span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {entry.capabilities.map((cap) => (
              <Badge key={cap} variant="secondary" className="px-1.5 py-0 text-[10px] capitalize">
                {cap}
              </Badge>
            ))}
            {/* Quantization (local only) is the disambiguator between two same-id quants, so it sits
                up front next to the context as a distinct, slightly emphasized label. */}
            {entry.quantization ? (
              <span className="font-medium text-foreground/70">{entry.quantization}</span>
            ) : null}
            {entry.contextLength != null ? <span>{fmtCtx(entry.contextLength)} ctx</span> : null}
            {entry.costTier != null ? <span>· {entry.costTier}</span> : null}
          </span>
        </span>
        {selected ? <Check className="size-4 shrink-0 text-primary" /> : null}
      </button>
      {onTogglePin ? (
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${entry.displayName}` : `Pin ${entry.displayName}`}
          className={cn(
            "mr-1 shrink-0 cursor-pointer rounded p-1.5 transition-opacity",
            pinned
              ? "text-amber-500"
              : "text-muted-foreground/50 opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Star className={cn("size-4", pinned && "fill-current")} />
        </button>
      ) : null}
    </div>
  );
}
