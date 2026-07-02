import { buildBm25Index, tokenize } from "./bm25";
import type { RecallAnchor, RecallFilters, RecallRecord } from "./types";

/**
 * The recall search path (D-044 M2): apply structured filters, rank the surviving records by
 * BM25, then collapse same-neighborhood hits and cap the result so one long exchange cannot
 * dominate. Pure over the corpus - the BM25 index is built on demand from the filtered
 * records, so search has no lifecycle of its own.
 *
 * Responsible for: filtering and BM25-ranking the recall corpus into deduped, capped anchors
 * with excerpts.
 */

/** Default number of anchors returned after dedupe. */
const DEFAULT_MAX_ANCHORS = 8;
/** Two hits in the same session within this many seqs are the same neighborhood - keep the best. */
const DEFAULT_DEDUPE_RADIUS = 4;
/** Excerpt width (chars) centred on the first matched query term. */
const EXCERPT_WIDTH = 200;

export interface RecallSearchCaps {
  readonly maxAnchors?: number;
  readonly dedupeRadius?: number;
}

export interface RecallSearchResult {
  readonly anchors: RecallAnchor[];
  /** Records searched after filtering - reported as a diagnostic so an empty result is explained. */
  readonly searchedRecords: number;
}

/** Whether a record satisfies every supplied filter (all AND-combined; an omitted filter passes). */
function matchesFilters(record: RecallRecord, filters: RecallFilters): boolean {
  if (filters.sessionIds && !filters.sessionIds.includes(record.session.sessionId)) {
    return false;
  }

  if (filters.kinds && !filters.kinds.includes(record.kind)) {
    return false;
  }

  if (filters.tool && record.tool !== filters.tool) {
    return false;
  }

  if (filters.foldId && record.foldId !== filters.foldId) {
    return false;
  }

  if (filters.turnRange) {
    const { fromSeq, toSeq } = filters.turnRange;
    // A record's span must OVERLAP the requested window (a fold spans many seqs; a point record
    // is its own seq), so a turn-range filter never silently drops a straddling fold.
    if (fromSeq != null && record.range.toSeq < fromSeq) {
      return false;
    }
    if (toSeq != null && record.range.fromSeq > toSeq) {
      return false;
    }
  }

  return true;
}

/** A short, query-centred excerpt of the record text (falls back to the head when no term hits). */
export function excerptFor(text: string, query: string): string {
  if (text.length <= EXCERPT_WIDTH) {
    return text;
  }

  const terms = new Set(tokenize(query));
  const lower = text.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (hit < 0 || at < hit)) {
      hit = at;
    }
  }

  if (hit < 0) {
    return `${text.slice(0, EXCERPT_WIDTH).trimEnd()}…`;
  }

  const start = Math.max(0, hit - Math.floor(EXCERPT_WIDTH / 3));
  const end = Math.min(text.length, start + EXCERPT_WIDTH);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/**
 * Searches the corpus for a query under optional filters and caps. Returns ranked anchors,
 * each de-duplicated so repeated excerpts from the same session neighborhood do not crowd out
 * other sources, plus the count of records actually searched (for the partial-search
 * diagnostics). An empty query or empty corpus returns no anchors, never an error.
 */
export function searchCorpus(
  records: readonly RecallRecord[],
  query: string,
  filters: RecallFilters = {},
  caps: RecallSearchCaps = {},
): RecallSearchResult {
  const maxAnchors = caps.maxAnchors ?? DEFAULT_MAX_ANCHORS;
  const dedupeRadius = caps.dedupeRadius ?? DEFAULT_DEDUPE_RADIUS;

  const filtered = records.filter((record) => matchesFilters(record, filters));
  const byId = new Map(filtered.map((record) => [record.id, record]));

  const index = buildBm25Index(filtered.map((record) => ({ id: record.id, text: record.text })));
  // Over-fetch before dedupe so collapsing a neighborhood still leaves enough distinct anchors.
  const hits = index.search(query, maxAnchors * 4);

  const anchors: RecallAnchor[] = [];
  const acceptedBySession = new Map<string, number[]>();

  for (const hit of hits) {
    const record = byId.get(hit.id);
    if (!record) {
      continue;
    }

    const accepted = acceptedBySession.get(record.session.sessionId) ?? [];
    const crowded = accepted.some((seq) => Math.abs(seq - record.seq) <= dedupeRadius);
    if (crowded) {
      continue; // a higher-scoring anchor already covers this neighborhood
    }

    anchors.push({ record, score: hit.score, excerpt: excerptFor(record.text, query) });
    accepted.push(record.seq);
    acceptedBySession.set(record.session.sessionId, accepted);

    if (anchors.length >= maxAnchors) {
      break;
    }
  }

  return { anchors, searchedRecords: filtered.length };
}
