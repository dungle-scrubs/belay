import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CatalogEntry,
  filterCatalog,
  type ModelRef,
  projectSourceState,
  type SourceAction,
  type SourceSummary,
  type SourceType,
  sameModel,
} from "@trevor/session";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Cpu,
  KeyRound,
  Network,
  Search,
  Sparkles,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type DeviceCodeFlow, needsAuthPanel, SourceAuthPanel } from "./source-auth-panel";

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

/** The human label + button variant for a source's primary action. */
const ACTION_LABEL: Record<SourceAction, string> = {
  authenticate: "Sign in",
  reauthenticate: "Re-authenticate",
  refresh: "Refresh catalog",
  configure: "Configure",
  disable: "Disable",
};

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
  /** An in-progress device/provider-code flow for the OPEN source (host-started), shown in its detail. */
  readonly deviceCode?: DeviceCodeFlow | null;
  /** Submit a non-key provider code for the open source's device-code flow. */
  readonly onSubmitCode?: (code: string) => void;
  /** Open directly on a source's detail view (deep link / Storybook); defaults to the overview. */
  readonly initialSourceId?: string;
  readonly className?: string;
}

/** The capability filter chips the detail view exposes (the M2 subset; M4 adds the full filter set). */
const CAPABILITY_FILTERS = ["tools", "vision", "reasoning"] as const;
type CapabilityFilter = (typeof CAPABILITY_FILTERS)[number];

export function ModelChooser({
  sources,
  catalogBySource,
  activeModel,
  loading,
  onSelectModel,
  onSourceAction,
  deviceCode,
  onSubmitCode,
  initialSourceId,
  className,
}: ModelChooserProps) {
  const [openSourceId, setOpenSourceId] = useState<string | null>(initialSourceId ?? null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<CapabilityFilter, boolean>>({
    tools: false,
    vision: false,
    reasoning: false,
  });

  const openSource = openSourceId
    ? (sources.find((s) => s.sourceId === openSourceId) ?? null)
    : null;

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
          onBack={() => {
            setOpenSourceId(null);
            setSearch("");
            setFilters({ tools: false, vision: false, reasoning: false });
          }}
          onSearch={setSearch}
          onToggleFilter={(f) => setFilters((prev) => ({ ...prev, [f]: !prev[f] }))}
          onSelectModel={onSelectModel}
          onSourceAction={onSourceAction}
          deviceCode={deviceCode}
          onSubmitCode={onSubmitCode}
        />
      ) : (
        <SourceOverview
          sources={sources}
          loading={loading}
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
  onOpenSource,
}: {
  sources: readonly SourceSummary[];
  loading?: boolean;
  onOpenSource: (sourceId: string) => void;
}) {
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
      <header>
        <h2 className="text-base font-medium">Choose a model</h2>
        <p className="text-sm text-muted-foreground">
          Pick a source to browse its models. Sources and their status are reported by the host.
        </p>
      </header>
      {SECTIONS.map(({ type, label }) => {
        const rows = sources.filter((s) => s.type === type);
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
                <SourceRow key={source.sourceId} source={source} onOpen={onOpenSource} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** One source row: label, host status summary, model count, the available action, and a click-through. */
function SourceRow({
  source,
  onOpen,
}: {
  source: SourceSummary;
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
        <span className="truncate text-sm font-medium">{source.label}</span>
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
          {ACTION_LABEL[action]}
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
  filters: Record<CapabilityFilter, boolean>;
  activeModel?: ModelRef | null;
  onBack: () => void;
  onSearch: (text: string) => void;
  onToggleFilter: (f: CapabilityFilter) => void;
  onSelectModel: (ref: ModelRef) => void;
  onSourceAction?: (sourceId: string, action: SourceAction) => void;
  deviceCode?: DeviceCodeFlow | null;
  onSubmitCode?: (code: string) => void;
}) {
  const state = projectSourceState(source);
  const action = primaryAction(source);
  const showAuth = needsAuthPanel(source, deviceCode);

  // The FULL filtered set (no page cap), so a large gateway catalog (OpenRouter, 256+) is browsable;
  // ModelList virtualizes it when it is large.
  const matched = useMemo(
    () =>
      filterCatalog(entries, {
        text: search,
        filters: {
          tools: filters.tools || undefined,
          vision: filters.vision || undefined,
          reasoning: filters.reasoning || undefined,
        },
      }),
    [entries, search, filters],
  );

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
              {ACTION_LABEL[action]}
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
          {CAPABILITY_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filters[f]}
              onClick={() => onToggleFilter(f)}
              className={cn(
                "cursor-pointer rounded-full border px-2.5 py-0.5 text-xs capitalize transition-colors",
                filters[f]
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-card",
              )}
            >
              {f}
            </button>
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
        <ModelList entries={matched} activeModel={activeModel} onSelectModel={onSelectModel} />
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
  onSelectModel,
}: {
  entries: readonly CatalogEntry[];
  activeModel?: ModelRef | null;
  onSelectModel: (ref: ModelRef) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualize = entries.length > VIRTUALIZE_OVER;
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 12,
    enabled: virtualize,
  });
  const rowOf = (entry: CatalogEntry) => (
    <ModelRow
      entry={entry}
      selected={activeModel != null && sameModel(activeModel, entry)}
      onSelect={() =>
        onSelectModel({ sourceId: entry.sourceId, modelId: entry.modelId, reasoning: null })
      }
    />
  );
  return (
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
  );
}

/** A compact context-length label (e.g. 128000 -> "128K", 1_000_000 -> "1M"). */
function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Math.round(tokens / 100_000) / 10}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

/** One catalog model row: name, capability tags, context length, cost tier, and a selected check. */
function ModelRow({
  entry,
  selected,
  onSelect,
}: {
  entry: CatalogEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Select ${entry.displayName}`}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
        selected ? "bg-primary/10 text-foreground" : "hover:bg-card",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.displayName}</span>
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
          {entry.contextLength != null ? (
            <span>{contextLabel(entry.contextLength)} ctx</span>
          ) : null}
          {entry.costTier != null ? <span>· {entry.costTier}</span> : null}
        </span>
      </span>
      {selected ? <Check className="size-4 shrink-0 text-primary" /> : null}
    </button>
  );
}
