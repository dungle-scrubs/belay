import type { CatalogEntry, ModelKind } from "./model-source";

/** The default and hard-max page sizes for a catalog query, so a result can never blow the wire. */
export const CATALOG_PAGE_DEFAULT = 50;
export const CATALOG_PAGE_MAX = 200;

/**
 * The entry-derivable catalog filters (D-065 M4). These are computable from a {@link CatalogEntry}
 * alone; the preference-driven filters (configured-only, recent, pinned, recommended) are layered on
 * later from persisted M6 state, not here. `family` matches a substring of id/display name;
 * `tools`/`vision`/`reasoning` require that capability; `minContext` bounds the context length.
 */
export interface CatalogFilters {
  readonly sourceId?: string;
  readonly family?: string;
  readonly kind?: ModelKind;
  readonly tools?: boolean;
  readonly vision?: boolean;
  readonly reasoning?: boolean;
  readonly minContext?: number;
}

/** A catalog query: free-text search, entry-derivable filters, and a cursor/limit window. */
export interface CatalogQuery {
  readonly text?: string;
  readonly filters?: CatalogFilters;
  /** Offset into the matched set (default 0); pair with `nextCursor` from the previous page. */
  readonly cursor?: number;
  /** Page cap (default {@link CATALOG_PAGE_DEFAULT}, hard-capped at {@link CATALOG_PAGE_MAX}). */
  readonly limit?: number;
}

/** One page of a catalog query: the window of entries plus the totals + cursor needed to page on. */
export interface CatalogPage {
  readonly entries: readonly CatalogEntry[];
  /** Total matches BEFORE the cursor/limit window - what the source has, not what this page carries. */
  readonly total: number;
  /** The offset to pass as the next query's `cursor`, or null when this page exhausts the matches. */
  readonly nextCursor: number | null;
}

/** Whether an entry passes the entry-derivable filters. */
function passesFilters(entry: CatalogEntry, f: CatalogFilters): boolean {
  if (f.sourceId != null && entry.sourceId !== f.sourceId) {
    return false;
  }
  if (f.kind != null && entry.kind !== f.kind) {
    return false;
  }
  if (f.tools === true && !entry.capabilities.includes("tools")) {
    return false;
  }
  if (f.vision === true && !entry.capabilities.includes("vision")) {
    return false;
  }
  if (f.reasoning === true && !entry.capabilities.includes("reasoning")) {
    return false;
  }
  if (f.minContext != null && (entry.contextLength ?? 0) < f.minContext) {
    return false;
  }
  if (f.family != null && f.family !== "") {
    const hay = `${entry.modelId} ${entry.displayName}`.toLowerCase();
    if (!hay.includes(f.family.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/** Whether every search term appears in the entry's id, display name, or aliases. */
function passesText(entry: CatalogEntry, terms: readonly string[]): boolean {
  if (terms.length === 0) {
    return true;
  }
  const hay = `${entry.modelId} ${entry.displayName} ${entry.aliases.join(" ")}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/**
 * The host-backed catalog query path (D-065 M4): filter a catalog by free text + entry-derivable
 * filters, then return ONE bounded page with the totals + cursor to page on. This is why the host
 * never ships an entire gateway catalog to the browser on `host.online`: the browser asks for a
 * page at a time through this path, capped at {@link CATALOG_PAGE_MAX}. Pure + order-preserving, so
 * thousands-of-models, filtering, and cursoring are unit-tested directly. Stale entries are returned
 * (staleness is a display concern, not an exclusion).
 */
export function queryCatalog(all: readonly CatalogEntry[], query: CatalogQuery = {}): CatalogPage {
  const matched = filterCatalog(all, query);
  const limit = Math.min(
    Math.max(Math.floor(query.limit ?? CATALOG_PAGE_DEFAULT), 1),
    CATALOG_PAGE_MAX,
  );
  const start = Math.max(0, Math.floor(query.cursor ?? 0));
  const entries = matched.slice(start, start + limit);
  const end = start + entries.length;
  return { entries, total: matched.length, nextCursor: end < matched.length ? end : null };
}

/**
 * The UNBOUNDED filtered+searched matches over a catalog (the {@link queryCatalog} match step without
 * the page cap). The browser uses this for a single in-memory source's catalog so it can render the
 * full filtered set (then virtualize it for a large gateway), where the bounded page is for the
 * host-backed wire query. Pure + order-preserving.
 */
export function filterCatalog(
  all: readonly CatalogEntry[],
  query: Pick<CatalogQuery, "text" | "filters"> = {},
): CatalogEntry[] {
  const terms = (query.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const filters = query.filters ?? {};
  return all.filter((e) => passesFilters(e, filters) && passesText(e, terms));
}
