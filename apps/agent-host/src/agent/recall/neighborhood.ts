import type { RecallAnchor, RecallNeighborhood, RecallRecord } from "./types";

/**
 * Neighborhood expansion (D-044 M3): a search anchor is a single matched record, but a useful
 * recall needs the turns AROUND it - the question that prompted an answer, the tool result a
 * reply referenced. This expands each anchor into a bounded window of surrounding records from
 * the SAME session, capped per-neighborhood and across the whole recall so one long session
 * cannot exhaust the recall context budget. Pure over the corpus + anchors.
 */

export interface NeighborhoodCaps {
  /** Records to include on each side of the anchor within its session (default 3). */
  readonly radius?: number;
  /** Hard cap on records in a single neighborhood, anchor included (default 7). */
  readonly perNeighborhood?: number;
  /** Hard cap on records across ALL neighborhoods - the total recall context budget (default 40). */
  readonly totalRecords?: number;
}

const DEFAULT_RADIUS = 3;
const DEFAULT_PER_NEIGHBORHOOD = 7;
const DEFAULT_TOTAL_RECORDS = 40;

export interface NeighborhoodResult {
  readonly neighborhoods: RecallNeighborhood[];
  /** Anchors dropped because the total-records budget was already spent - surfaced as a diagnostic. */
  readonly droppedAnchors: number;
}

/** Groups records by session id, each list sorted ascending by seq (the durable-log order). */
function bySession(records: readonly RecallRecord[]): Map<string, RecallRecord[]> {
  const groups = new Map<string, RecallRecord[]>();
  for (const record of records) {
    const list = groups.get(record.session.sessionId) ?? [];
    list.push(record);
    groups.set(record.session.sessionId, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.seq - b.seq);
  }
  return groups;
}

/**
 * Expands ranked anchors into bounded neighborhoods, greedily until the total-records budget is
 * spent. Anchors are taken in the order given (already score-ranked), so the strongest matches
 * get their context first; once the budget is reached the remaining anchors are reported as
 * dropped rather than silently lost. Records already pulled into an earlier neighborhood are not
 * double-counted, so two nearby anchors share one window instead of inflating the budget.
 */
export function expandNeighborhoods(
  corpus: readonly RecallRecord[],
  anchors: readonly RecallAnchor[],
  caps: NeighborhoodCaps = {},
): NeighborhoodResult {
  const radius = caps.radius ?? DEFAULT_RADIUS;
  const perNeighborhood = caps.perNeighborhood ?? DEFAULT_PER_NEIGHBORHOOD;
  const totalRecords = caps.totalRecords ?? DEFAULT_TOTAL_RECORDS;

  const groups = bySession(corpus);
  const neighborhoods: RecallNeighborhood[] = [];
  const usedIds = new Set<string>();
  let droppedAnchors = 0;

  for (const anchor of anchors) {
    if (usedIds.size >= totalRecords) {
      droppedAnchors += 1;
      continue;
    }

    const list = groups.get(anchor.record.session.sessionId) ?? [anchor.record];
    const center = list.findIndex((record) => record.id === anchor.record.id);
    const at = center >= 0 ? center : 0;

    const lo = Math.max(0, at - radius);
    const hi = Math.min(list.length, at + radius + 1);
    let window = list.slice(lo, hi);

    // Keep the anchor centred when trimming to the per-neighborhood cap, so context on both
    // sides survives rather than lopping only the tail.
    if (window.length > perNeighborhood) {
      const anchorInWindow = window.findIndex((record) => record.id === anchor.record.id);
      const half = Math.floor(perNeighborhood / 2);
      const start = Math.max(0, Math.min(anchorInWindow - half, window.length - perNeighborhood));
      window = window.slice(start, start + perNeighborhood);
    }

    const fresh = window.filter((record) => !usedIds.has(record.id));
    if (fresh.length === 0) {
      continue; // fully covered by an earlier neighborhood - the anchor adds nothing new
    }

    const remaining = totalRecords - usedIds.size;
    const bounded = fresh.length > remaining ? fresh.slice(0, remaining) : fresh;
    for (const record of bounded) {
      usedIds.add(record.id);
    }

    // Render only the records THIS neighborhood newly contributes (in seq order). Nearby anchors
    // therefore never repeat a record across blocks; the search-level dedupe keeps real anchors far
    // enough apart that each neighborhood still centres on its own anchor.
    neighborhoods.push({ anchor, records: bounded });
  }

  return { neighborhoods, droppedAnchors };
}
