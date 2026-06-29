/**
 * The freshness policy for cached corpora: a corpus is fresh for `freshnessHours` after its last
 * fetch and stale afterwards, so a fresh corpus is reused without touching the network and a stale one
 * is refreshed intentionally. This module is the freshness POLICY only - it decides stale-vs-fresh and
 * what a reuse request resolves to before any fetching; it never ranks or excerpts content (that is the
 * query module's concern), and it never reads the wall clock (the caller injects `now`), so the
 * staleness boundary is deterministic under test. Keeping it apart from query ranking means refresh
 * and ranking never entangle.
 */

import type { Corpus } from "./corpus";

/** The default freshness window: a corpus whose freshness horizon has passed by this many hours is stale. */
export const DEFAULT_FRESHNESS_HOURS = 24;

/**
 * Whether `now` is at or past a freshness horizon. Both are ISO-8601 instants; the horizon is reached
 * inclusively (a corpus is stale once `now` equals its `staleAfter`). An unparseable pair is treated
 * as stale, since freshness cannot be proven from a bad timestamp.
 */
export function isStaleAt(staleAfter: string, now: string): boolean {
  const horizon = Date.parse(staleAfter);
  const at = Date.parse(now);

  if (Number.isNaN(horizon) || Number.isNaN(at)) {
    return true;
  }

  return at >= horizon;
}

/** Whether a corpus has passed its freshness horizon as of `now`. */
export function isCorpusStale(corpus: Corpus, now: string): boolean {
  return isStaleAt(corpus.staleAfter, now);
}

/** What a reuse request resolves to before any network work happens. */
export type RefreshDecision = "reuse-fresh" | "reuse-stale" | "refresh";

/** The inputs the refresh policy decides on: whether a cached corpus exists, its staleness, and the
 *  caller's two opt-ins (force a refresh, or accept stale content without one). */
export interface RefreshRequest {
  readonly exists: boolean;
  readonly stale: boolean;
  /** The caller asked to re-fetch even if the cached corpus is still fresh. */
  readonly allowRefresh: boolean;
  /** The caller accepts stale content as-is, with no refresh attempt. */
  readonly allowStale: boolean;
}

/**
 * Decides what to do with a reuse request, separate from any fetching: reuse a fresh corpus (no
 * network), serve a stale corpus as-is when the caller accepts stale (no network), or refresh. A
 * request with no cached corpus always refreshes (builds). `allowStale` wins over `allowRefresh`: a
 * caller that explicitly accepts stale content is never put through a network refresh.
 */
export function decideRefresh(request: RefreshRequest): RefreshDecision {
  if (!request.exists) {
    return "refresh";
  }

  if (request.allowStale) {
    return request.stale ? "reuse-stale" : "reuse-fresh";
  }

  if (request.allowRefresh) {
    return "refresh";
  }

  return request.stale ? "refresh" : "reuse-fresh";
}
