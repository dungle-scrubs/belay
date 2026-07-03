/**
 * The read-only docs query actions over already-cached corpora: search (ranked cited excerpts), read
 * (one bounded page view), list (the corpus inventory), and status (a corpus's freshness/coverage).
 * These read the filesystem only - a query action never touches the network - and every result is
 * capped with a continuation cursor, so a large corpus never dumps wholesale into the prompt.
 *
 * Responsible for: the search/read/list/status actions over cached corpora.
 * Not for: building or refreshing corpora - build-actions.ts.
 */

import { type Corpus, canonicalUrl, type Page } from "./corpus";
import { excerptWindow } from "./corpus-results";
import { createCorpusStore, requireLoadedCorpus, summarizeCorpus } from "./corpus-store";
import type { ReadyDocsDeps } from "./deps";
import { type DocsResult, errorResult } from "./envelope";
import { isCorpusStale, isStaleAt } from "./freshness";
import { locateCorpus, targetRef } from "./locate";
import {
  clamp,
  DEFAULT_MAX_RESULTS,
  type DocsArgs,
  MAX_RESULTS_CEILING,
  MAX_RESULTS_FLOOR,
} from "./params";
import { clampOffset, readPage, searchCorpus } from "./query";

/** How many corpora a single `list` page returns before continuation. */
const DOCS_LIST_PAGE = 25;

export async function searchAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  const query = args.query?.trim();

  if (!query) {
    return errorResult("search", "docs search needs a query");
  }

  if (!args.corpusId && !args.subject?.trim() && !args.url?.trim()) {
    return errorResult(
      "search",
      "docs search needs a corpusId, subject, or url to target a corpus",
    );
  }

  const loaded = await locateCorpus(args, deps);
  const required = requireLoadedCorpus("search", loaded, targetRef(args));

  if (!("state" in required)) {
    return required;
  }

  const limit = clamp(args.maxResults, MAX_RESULTS_FLOOR, MAX_RESULTS_CEILING, DEFAULT_MAX_RESULTS);
  const offset = clampOffset(args.offset);
  const ranked = searchCorpus(required.pages, query, { offset, limit });
  const stale = isCorpusStale(required.corpus, deps.now());

  return {
    action: "search",
    outcome: "ok",
    detail: `docs search: ${ranked.excerpts.length} excerpt(s) for "${query}" in ${required.corpus.corpusId}${
      stale ? " (stale)" : ""
    }`,
    corpus: summarizeCorpus(required.corpus),
    query: { corpusId: required.corpus.corpusId, query, excerpts: ranked.excerpts },
    window: excerptWindow(ranked),
    stale,
    ...(required.diagnostics.length > 0 ? { diagnostics: required.diagnostics } : {}),
  };
}

/** Finds a page in a corpus by pageId, or by the canonical URL of either its requested or final URL. */
function findPage(pages: readonly Page[], args: DocsArgs): Page | undefined {
  if (args.pageId) {
    return pages.find((page) => page.pageId === args.pageId);
  }

  const raw = args.url?.trim();

  if (!raw) {
    return undefined;
  }

  const canon = canonicalUrl(raw);

  return pages.find(
    (page) => canonicalUrl(page.url) === canon || canonicalUrl(page.finalUrl) === canon,
  );
}

export async function readAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  if (!args.corpusId) {
    return errorResult("read", "docs read needs a corpusId");
  }

  if (!args.pageId && !args.url?.trim()) {
    return errorResult("read", "docs read needs a pageId or url");
  }

  const store = createCorpusStore(deps.fs, deps.corpusRoot);
  const loaded = await store.loadCorpus(args.corpusId);
  const required = requireLoadedCorpus("read", loaded, args.corpusId);

  if (!("state" in required)) {
    return required;
  }

  const page = findPage(required.pages, args);

  if (!page) {
    return errorResult(
      "read",
      `docs read: page ${args.pageId ?? args.url} not found in ${args.corpusId}`,
    );
  }

  const offset = clampOffset(args.offset);
  const result = readPage(page, { offset });
  const stale = isCorpusStale(required.corpus, deps.now());

  return {
    action: "read",
    outcome: "ok",
    detail: `docs read: ${page.pageId} (${result.view.content.length} of ${result.total} chars)${
      stale ? " (stale)" : ""
    }`,
    corpus: summarizeCorpus(required.corpus),
    page: result.view,
    window: {
      unit: "chars",
      returned: result.view.content.length,
      total: result.total,
      truncated: result.nextOffset !== undefined,
      ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
    },
    stale,
  };
}

export async function listAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  const store = createCorpusStore(deps.fs, deps.corpusRoot);
  const summaries = [...(await store.listCorpora())].sort(
    (a, b) =>
      (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) ||
      (a.corpusId < b.corpusId ? -1 : a.corpusId > b.corpusId ? 1 : 0),
  );

  const total = summaries.length;
  const offset = clampOffset(args.offset);
  const limit = clamp(args.maxResults, MAX_RESULTS_FLOOR, MAX_RESULTS_CEILING, DOCS_LIST_PAGE);
  const windowed = summaries.slice(offset, offset + limit);
  const now = deps.now();
  const corpora = windowed.map((summary) => ({
    ...summary,
    stale: isStaleAt(summary.staleAfter, now),
  }));
  const next = offset + windowed.length < total ? offset + windowed.length : undefined;

  return {
    action: "list",
    outcome: "ok",
    detail: `docs list: ${windowed.length} of ${total} corpus/corpora`,
    corpora,
    window: {
      unit: "corpora",
      returned: windowed.length,
      total,
      truncated: next !== undefined,
      ...(next !== undefined ? { nextOffset: next } : {}),
    },
  };
}

/** Status diagnostics: the corpus's own partial/skip/fail notes plus anything the load surfaced. */
function statusDiagnostics(corpus: Corpus, loadDiagnostics: readonly string[]): readonly string[] {
  const lines: string[] = [];

  if (corpus.partial) {
    lines.push("corpus is partial: some pages were skipped or failed");
  }

  if (corpus.truncated) {
    lines.push("some pages were truncated to the fetch cap");
  }

  if (corpus.skipped.length > 0) {
    lines.push(`${corpus.skipped.length} url(s) skipped during discovery/fetch`);
  }

  for (const page of corpus.failed) {
    lines.push(`failed: ${page.url}: ${page.reason}`);
  }

  return [...lines, ...loadDiagnostics];
}

export async function statusAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  if (!args.corpusId && !args.subject?.trim() && !args.url?.trim()) {
    return errorResult("status", "docs status needs a corpusId, subject, or url");
  }

  const loaded = await locateCorpus(args, deps);
  const required = requireLoadedCorpus("status", loaded, targetRef(args));

  if (!("state" in required)) {
    return required;
  }

  const corpus = required.corpus;
  const stale = isCorpusStale(corpus, deps.now());
  const diagnostics = statusDiagnostics(corpus, required.diagnostics);

  return {
    action: "status",
    outcome: "ok",
    detail: `docs status: ${corpus.corpusId} - ${corpus.pageCount} page(s), ${
      stale ? "stale" : "fresh"
    }${corpus.partial ? ", partial" : ""}`,
    corpus: summarizeCorpus(corpus),
    provenance: corpus.provenance,
    stale,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}
