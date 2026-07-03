/**
 * The corpus-building docs actions - resolve and refresh - and the shared pipeline behind them:
 * discover a documentation root (web_search / an anchored URL), fetch + normalize its pages through
 * web_fetch, and persist the corpus through the store. resolve reuses a fresh cached corpus without
 * any network call (the freshness policy decides); refresh rebuilds intentionally; and a rebuild that
 * fails falls back to the stale cache, explicitly tagged, rather than losing the content.
 *
 * Responsible for: the resolve/refresh actions and the discover -> fetch -> persist build pipeline.
 * Not for: the read-only query actions over cached corpora - query-actions.ts.
 */

import {
  type Corpus,
  corpusIdFor,
  DOCS_CORPUS_VERSION,
  type PageDiagnostic,
  staleAfterFrom,
} from "./corpus";
import { okCorpusResult, reuseResult, staleFallback } from "./corpus-results";
import { createCorpusStore, requireLoadedCorpus } from "./corpus-store";
import type { ReadyDocsDeps } from "./deps";
import { type DiscoveryResult, resolveCandidates } from "./discovery";
import { type DocsAction, type DocsResult, errorResult, unavailableResult } from "./envelope";
import { fetchPages } from "./fetch-pages";
import { DEFAULT_FRESHNESS_HOURS, decideRefresh, isCorpusStale } from "./freshness";
import { type BuildSpec, loadExisting, specFrom } from "./locate";
import type { DocsArgs } from "./params";

/** web_fetch strategy docs reads pages with: "auto" lets web_fetch own the static/rendered ladder. */
const DEFAULT_FETCH_MODE = "auto" as const;

/** Character cap docs asks web_fetch for per page (web_fetch's own default). */
const DOCS_PAGE_MAX_CHARS = 12_000;

/** How many hours a freshly built corpus stays fresh before it is considered stale (the freshness
 *  policy default; the policy itself lives in `freshness.ts`). */
const DOCS_FRESHNESS_HOURS = DEFAULT_FRESHNESS_HOURS;

/** The corpus-level provenance line: how the root was found plus how pages were read. */
function provenanceLine(discovery: DiscoveryResult, pages: number, failed: number): string {
  return `${discovery.provenance}; web_fetch ${DEFAULT_FETCH_MODE}; ${pages} page(s), ${failed} failed`;
}

/** The model-facing diagnostics for a built corpus: discovery notes, failed reads, and a skip count. */
function buildDiagnostics(
  discovery: DiscoveryResult,
  failed: readonly PageDiagnostic[],
  skipped: readonly PageDiagnostic[],
): readonly string[] {
  const lines = [...discovery.diagnostics];

  for (const page of failed) {
    lines.push(`failed: ${page.url}: ${page.reason}`);
  }

  if (skipped.length > 0) {
    lines.push(`skipped ${skipped.length} url(s): out of scope / robots / cap / duplicate`);
  }

  return lines;
}

/**
 * Discovers, fetches, normalizes, and persists a corpus for one (subject|url, version). This is the
 * shared pipeline behind `resolve` and `refresh`. A failed page read marks the corpus partial rather
 * than throwing the turn; a corpus with zero usable pages reports a typed error with the read
 * diagnostics.
 */
async function buildAndStore(
  action: DocsAction,
  spec: BuildSpec,
  deps: ReadyDocsDeps,
): Promise<DocsResult> {
  const discovery = await resolveCandidates(
    {
      ...(spec.subject ? { subject: spec.subject } : {}),
      ...(spec.url ? { url: spec.url } : {}),
      ...(spec.version ? { version: spec.version } : {}),
      maxPages: spec.maxPages,
    },
    { webFetch: deps.webFetch, ...(deps.webSearch ? { webSearch: deps.webSearch } : {}) },
  );

  if (discovery.candidates.length === 0) {
    if (spec.subject && !spec.url && !deps.webSearch) {
      return unavailableResult(action, ["web_search"]);
    }

    return errorResult(
      action,
      `docs ${action} could not resolve any documentation pages`,
      discovery.diagnostics,
    );
  }

  const subject = spec.subject ?? discovery.host;
  const corpusId = corpusIdFor({
    subject,
    rootUrl: discovery.rootUrl,
    ...(spec.version ? { version: spec.version } : {}),
  });

  const store = createCorpusStore(deps.fs, deps.corpusRoot);
  const existing = await store.loadCorpus(corpusId);
  const createdAt = existing.state === "loaded" ? existing.corpus.createdAt : deps.now();

  const fetched = await fetchPages(
    {
      corpusId,
      host: discovery.host,
      candidates: discovery.candidates,
      fetchMode: DEFAULT_FETCH_MODE,
      maxChars: DOCS_PAGE_MAX_CHARS,
      freshnessHours: DOCS_FRESHNESS_HOURS,
      now: deps.now,
    },
    deps.webFetch,
  );

  if (fetched.pages.length === 0) {
    return errorResult(action, `docs ${action} fetched no usable pages for ${subject}`, [
      ...discovery.diagnostics,
      ...fetched.failed.map((page) => `failed: ${page.url}: ${page.reason}`),
    ]);
  }

  const now = deps.now();
  const skipped = [...discovery.skipped, ...fetched.skipped];
  const partial = discovery.partial || fetched.failed.length > 0;

  const corpus: Corpus = {
    version: DOCS_CORPUS_VERSION,
    corpusId,
    subject,
    name: subject,
    source: {
      rootUrl: discovery.rootUrl,
      host: discovery.host,
      ...(spec.version ? { version: spec.version } : {}),
    },
    createdAt,
    updatedAt: now,
    staleAfter: staleAfterFrom(now, DOCS_FRESHNESS_HOURS),
    policy: {
      maxPages: spec.maxPages,
      fetchMode: DEFAULT_FETCH_MODE,
      freshnessHours: DOCS_FRESHNESS_HOURS,
    },
    pageCount: fetched.pages.length,
    byteCount: fetched.byteCount,
    truncated: fetched.truncated,
    partial,
    provenance: provenanceLine(discovery, fetched.pages.length, fetched.failed.length),
    skipped,
    failed: fetched.failed,
  };

  await store.saveCorpus(corpus, fetched.pages);

  const detail = `docs ${action} built corpus ${corpusId} for ${subject}: ${corpus.pageCount} page(s)${
    partial ? " (partial)" : ""
  }`;

  return okCorpusResult(action, corpus, fetched.pages, {
    detail,
    stale: false,
    diagnostics: buildDiagnostics(discovery, fetched.failed, skipped),
  });
}

export async function resolveAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  if (!args.subject?.trim() && !args.url?.trim()) {
    return errorResult("resolve", "docs resolve needs a subject or a url");
  }

  const spec = specFrom(args);
  const existing = await loadExisting(spec, deps);

  if (existing) {
    const stale = isCorpusStale(existing.corpus, deps.now());
    const decision = decideRefresh({
      exists: true,
      stale,
      allowRefresh: args.allowRefresh === true,
      allowStale: args.allowStale === true,
    });

    if (decision === "reuse-fresh") {
      return reuseResult("resolve", existing, false);
    }

    if (decision === "reuse-stale") {
      return reuseResult("resolve", existing, true);
    }

    const built = await buildAndStore("resolve", spec, deps);

    return built.outcome === "ok" ? built : staleFallback("resolve", existing, built);
  }

  return buildAndStore("resolve", spec, deps);
}

export async function refreshAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  if (args.corpusId) {
    const store = createCorpusStore(deps.fs, deps.corpusRoot);
    const loaded = await store.loadCorpus(args.corpusId);
    const required = requireLoadedCorpus("refresh", loaded, args.corpusId);

    if (!("state" in required)) {
      return required;
    }

    const corpus = required.corpus;
    const built = await buildAndStore(
      "refresh",
      {
        subject: corpus.subject,
        url: corpus.source.rootUrl,
        ...(corpus.source.version ? { version: corpus.source.version } : {}),
        maxPages: corpus.policy.maxPages,
      },
      deps,
    );

    return built.outcome === "ok" ? built : staleFallback("refresh", required, built);
  }

  if (!args.subject?.trim() && !args.url?.trim()) {
    return errorResult("refresh", "docs refresh needs a corpusId, subject, or url");
  }

  const spec = specFrom(args);
  const existing = await loadExisting(spec, deps);
  const built = await buildAndStore("refresh", spec, deps);

  if (built.outcome === "ok") {
    return built;
  }

  return existing ? staleFallback("refresh", existing, built) : built;
}
