/**
 * Shaping the ok-outcome corpus results the docs actions return: the bounded lead-excerpt preview a
 * built or reused corpus carries, the excerpt result-window, the cached-reuse result, and the stale
 * fallback served when a refresh cannot complete. Stale content is always tagged `stale: true` (with
 * the refresh-failure reason as diagnostics), so it is never presented as fresh.
 *
 * Responsible for: ok corpus DocsResults - excerpt previews, result windows, reuse, stale fallback.
 * Not for: the typed outcome envelope and its error constructors - envelope.ts.
 */

import type { Corpus, Page } from "./corpus";
import { summarizeCorpus } from "./corpus-store";
import type { DocsAction, DocsResult, ResultWindow } from "./envelope";
import type { LoadedCorpus } from "./locate";
import { previewExcerpts, type Ranked } from "./query";

/** How many lead excerpts a resolve/refresh preview returns (capped, continuable). */
const DEFAULT_PREVIEW_EXCERPTS = 6;

/** The result-window for a capped excerpt set (resolve/refresh preview or search). */
export function excerptWindow(ranked: Ranked): ResultWindow {
  return {
    unit: "excerpts",
    returned: ranked.excerpts.length,
    total: ranked.total,
    truncated: ranked.nextOffset !== undefined,
    ...(ranked.nextOffset !== undefined ? { nextOffset: ranked.nextOffset } : {}),
  };
}

/** A successful corpus result: the summary, a bounded preview of cited excerpts, and the stale flag. */
export function okCorpusResult(
  action: DocsAction,
  corpus: Corpus,
  pages: readonly Page[],
  opts: {
    readonly detail: string;
    readonly stale: boolean;
    readonly diagnostics?: readonly string[];
  },
): DocsResult {
  const ranked = previewExcerpts(pages, { offset: 0, limit: DEFAULT_PREVIEW_EXCERPTS });

  return {
    action,
    outcome: "ok",
    detail: opts.detail,
    corpus: summarizeCorpus(corpus),
    excerpts: ranked.excerpts,
    window: excerptWindow(ranked),
    stale: opts.stale,
    ...(opts.diagnostics && opts.diagnostics.length > 0 ? { diagnostics: opts.diagnostics } : {}),
  };
}

/** Returns a cached corpus as-is (no network), tagged with its freshness. */
export function reuseResult(action: DocsAction, loaded: LoadedCorpus, stale: boolean): DocsResult {
  const detail = `docs ${action}: reused cached corpus ${loaded.corpus.corpusId} (${loaded.corpus.pageCount} page(s))${
    stale ? ", STALE" : ""
  }`;

  return okCorpusResult(action, loaded.corpus, loaded.pages, {
    detail,
    stale,
    ...(loaded.diagnostics.length > 0 ? { diagnostics: loaded.diagnostics } : {}),
  });
}

/**
 * Falls back to a stale cached corpus when a refresh could not complete (network failure). The stale
 * content is returned with an explicit `stale: true` and the refresh-failure reason, so stale content
 * is never presented as fresh.
 */
export function staleFallback(
  action: DocsAction,
  loaded: LoadedCorpus,
  failed: DocsResult,
): DocsResult {
  return okCorpusResult(action, loaded.corpus, loaded.pages, {
    detail: `docs ${action}: refresh failed, served STALE cached corpus ${loaded.corpus.corpusId}`,
    stale: true,
    diagnostics: [
      `refresh failed: ${failed.detail}`,
      ...(failed.diagnostics ?? []),
      ...loaded.diagnostics,
    ],
  });
}
