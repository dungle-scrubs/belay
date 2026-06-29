/**
 * The docs tool entry: a read-only, model-facing lookup + cache for EXTERNAL documentation
 * (products, APIs, libraries, SDKs, services). It is NOT a crawler, a browser, or a workspace-code
 * search tool. Discovery reuses web_search (Phase 3) and page reads reuse web_fetch (Phase 4); the
 * normalized corpora are persisted under the docs-corpus state root through the root policy. This
 * module owns the param contract, the dependency-readiness gate, and the action router. A missing
 * dependency resolves to a typed `unavailable` outcome rather than throwing the turn, and each action
 * routes to its own service seam (stubs returning a typed `not-implemented` until their phase lands).
 */

import { storagePathByName } from "@trevor/session/node-paths";
import { Schema } from "effect";
import { simpleTool } from "../shared";
import { runWebFetch, webFetchLiveDeps } from "../web-fetch/web-fetch";
import { runWebSearch } from "../web-search";
import {
  type Corpus,
  canonicalUrl,
  corpusIdFor,
  DOCS_CORPUS_VERSION,
  hostOf,
  type Page,
  type PageDiagnostic,
  staleAfterFrom,
} from "./corpus";
import {
  type CorpusStore,
  createCorpusStore,
  type DocsFs,
  type LoadResult,
  nodeDocsFs,
  summarizeCorpus,
} from "./corpus-store";
import { type DiscoveryResult, resolveCandidates } from "./discovery";
import {
  corruptResult,
  DOCS_ACTIONS,
  type DocsAction,
  type DocsResult,
  errorResult,
  type ResultWindow,
  serializeDocsResult,
  unavailableResult,
} from "./envelope";
import { fetchPages } from "./fetch-pages";
import { DEFAULT_FRESHNESS_HOURS, decideRefresh, isCorpusStale, isStaleAt } from "./freshness";
import { clampOffset, previewExcerpts, type Ranked, readPage, searchCorpus } from "./query";
import type { WebFetchReader, WebSearchReader } from "./readers";

const MAX_PAGES_FLOOR = 1;
const MAX_PAGES_CEILING = 200;
const DEFAULT_MAX_PAGES = 40;

const MAX_RESULTS_FLOOR = 1;
const MAX_RESULTS_CEILING = 50;
const DEFAULT_MAX_RESULTS = 8;

/** How many lead excerpts a resolve/refresh preview returns (capped, continuable). */
const DEFAULT_PREVIEW_EXCERPTS = 6;

/** How many corpora a single `list` page returns before continuation. */
const DOCS_LIST_PAGE = 25;

/** web_fetch strategy docs reads pages with: "auto" lets web_fetch own the static/rendered ladder. */
const DEFAULT_FETCH_MODE = "auto" as const;

/** Character cap docs asks web_fetch for per page (web_fetch's own default). */
const DOCS_PAGE_MAX_CHARS = 12_000;

/** How many hours a freshly built corpus stays fresh before it is considered stale (the freshness
 *  policy default; the policy itself lives in `freshness.ts`). */
const DOCS_FRESHNESS_HOURS = DEFAULT_FRESHNESS_HOURS;

/** The docs-corpus storage inventory name owned by the root policy (`@trevor/session/node-paths`). */
const DOCS_CORPUS_ENTRY = "docs-corpus";

const Params = Schema.Struct({
  action: Schema.Literal(...DOCS_ACTIONS).annotations({
    description:
      "What to do: 'resolve' (find/build a corpus for a subject), 'refresh' (re-fetch a stale " +
      "corpus), 'search' (query within a corpus), 'read' (read one cached page), 'list' (known " +
      "corpora), or 'status' (a corpus's freshness/coverage).",
  }),
  subject: Schema.optional(Schema.String).annotations({
    description:
      "The product/API/library/SDK/service to look up docs for (resolve/refresh/search).",
  }),
  url: Schema.optional(Schema.String).annotations({
    description: "A known documentation root or page URL to anchor resolution to (optional).",
  }),
  query: Schema.optional(Schema.String).annotations({
    description: "The question to answer from a corpus (search).",
  }),
  pageId: Schema.optional(Schema.String).annotations({
    description: "A specific cached page id to read (read).",
  }),
  corpusId: Schema.optional(Schema.String).annotations({
    description: "Target an existing corpus by id (refresh/search/read/status).",
  }),
  version: Schema.optional(Schema.String).annotations({
    description: "Pin a documented product/library version for resolution (optional).",
  }),
  // maxPages/maxResults decode leniently (any number) and are clamped in code; the advertised schema
  // still presents them as bounded integers (the model-facing hint), like web_fetch's caps.
  maxPages: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: MAX_PAGES_FLOOR, maximum: MAX_PAGES_CEILING },
    }),
  ).annotations({
    description: `Cap on pages a resolve/refresh may gather, clamped to [${MAX_PAGES_FLOOR}, ${MAX_PAGES_CEILING}] (default ${DEFAULT_MAX_PAGES})`,
  }),
  maxResults: Schema.optional(
    Schema.Number.annotations({
      jsonSchema: { type: "integer", minimum: MAX_RESULTS_FLOOR, maximum: MAX_RESULTS_CEILING },
    }),
  ).annotations({
    description: `Cap on search excerpts returned, clamped to [${MAX_RESULTS_FLOOR}, ${MAX_RESULTS_CEILING}] (default ${DEFAULT_MAX_RESULTS})`,
  }),
  offset: Schema.optional(
    Schema.Number.annotations({ jsonSchema: { type: "integer", minimum: 0 } }),
  ).annotations({
    description:
      "Continuation cursor from a prior result's window.nextOffset (search/read/list), to page " +
      "past a capped result.",
  }),
  allowRefresh: Schema.optional(Schema.Boolean).annotations({
    description:
      "On resolve, re-fetch even when the cached corpus is still fresh (default false: a fresh " +
      "corpus is reused without any network call).",
  }),
  allowStale: Schema.optional(Schema.Boolean).annotations({
    description:
      "Serve cached content without a network refresh; past its freshness window it is returned " +
      "marked stale rather than re-fetched (default false).",
  }),
});

type DocsArgs = typeof Params.Type;

/** Injectable dependencies, so the whole docs path is deterministic under test. */
export interface DocsDeps {
  readonly webFetch?: WebFetchReader;
  readonly webSearch?: WebSearchReader;
  /** The absolute docs-corpus root, or null when the root policy cannot classify it. */
  readonly corpusRoot: string | null;
  readonly fs: DocsFs;
  readonly now: () => string;
}

/** `DocsDeps` after the dependency gate has passed: web_fetch and the corpus root are guaranteed. */
interface ReadyDocsDeps {
  readonly webFetch: WebFetchReader;
  readonly webSearch?: WebSearchReader;
  readonly corpusRoot: string;
  readonly fs: DocsFs;
  readonly now: () => string;
}

/** Clamps a lenient numeric arg into [floor, ceiling], falling back when absent/non-finite. */
function clamp(
  value: number | undefined,
  floor: number,
  ceiling: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), floor), ceiling);
}

/** The required dependencies that are not ready, in stable order; empty means the gate passes. */
function missingDependencies(deps: DocsDeps): readonly string[] {
  const missing: string[] = [];

  if (!deps.webFetch) {
    missing.push("web_fetch");
  }

  if (deps.corpusRoot === null) {
    missing.push("docs corpus root");
  }

  return missing;
}

/**
 * Routes one action to its service seam. `resolve`/`refresh` build or reuse a corpus end-to-end; the
 * query actions (`search`/`read`/`list`/`status`) read the cached corpora. The dependency gate has
 * already passed by here, so web_fetch and the corpus root exist.
 */
async function dispatch(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  switch (args.action) {
    case "resolve":
      return resolveAction(args, deps);
    case "refresh":
      return refreshAction(args, deps);
    case "search":
      return searchAction(args, deps);
    case "read":
      return readAction(args, deps);
    case "list":
      return listAction(args, deps);
    case "status":
      return statusAction(args, deps);
  }
}

/** The corpus-shaping inputs both resolve and refresh feed into the build pipeline. */
interface BuildSpec {
  readonly subject?: string;
  readonly url?: string;
  readonly version?: string;
  readonly maxPages: number;
}

function specFrom(args: DocsArgs): BuildSpec {
  return {
    ...(args.subject?.trim() ? { subject: args.subject.trim() } : {}),
    ...(args.url?.trim() ? { url: args.url.trim() } : {}),
    ...(args.version?.trim() ? { version: args.version.trim() } : {}),
    maxPages: clamp(args.maxPages, MAX_PAGES_FLOOR, MAX_PAGES_CEILING, DEFAULT_MAX_PAGES),
  };
}

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
 * shared pipeline behind `resolve` and `refresh`; freshness-based reuse of an existing corpus lands in
 * Phase 5, so for now both always rebuild. A failed page read marks the corpus partial rather than
 * throwing the turn; a corpus with zero usable pages reports a typed error with the read diagnostics.
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

/** A corpus that loaded cleanly off disk: the manifest, its pages, and any load diagnostics. */
type LoadedCorpus = Extract<LoadResult, { state: "loaded" }>;

/**
 * Predicts the corpus id a build of `spec` would target WITHOUT any network, so a fresh corpus can be
 * reused before discovery runs. This is possible only when an explicit URL is given (the root is the
 * URL and the subject defaults to its host); a subject-only request needs a web_search to find the
 * root, so it falls back to a by-subject scan instead.
 */
function predictCorpusId(spec: BuildSpec): string | undefined {
  if (!spec.url) {
    return undefined;
  }

  const host = hostOf(spec.url);

  if (host === "") {
    return undefined;
  }

  return corpusIdFor({
    subject: spec.subject ?? host,
    rootUrl: spec.url,
    ...(spec.version ? { version: spec.version } : {}),
  });
}

/** Finds a cached corpus id by subject (and version, exactly), scanning the on-disk inventory. */
async function findBySubject(
  store: CorpusStore,
  subject: string,
  version: string | undefined,
): Promise<string | undefined> {
  const target = subject.trim().toLowerCase();
  const wantVersion = (version ?? "").trim().toLowerCase();

  for (const summary of await store.listCorpora()) {
    if (
      summary.subject.trim().toLowerCase() === target &&
      (summary.version ?? "").toLowerCase() === wantVersion
    ) {
      return summary.corpusId;
    }
  }

  return undefined;
}

/**
 * Loads an already-cached corpus matching `spec` without any network: by the predicted id when the
 * URL makes it derivable, otherwise by a by-subject scan. Reads the filesystem only.
 */
async function loadExisting(
  spec: BuildSpec,
  deps: ReadyDocsDeps,
): Promise<LoadedCorpus | undefined> {
  const store = createCorpusStore(deps.fs, deps.corpusRoot);
  const predicted = predictCorpusId(spec);

  if (predicted) {
    const loaded = await store.loadCorpus(predicted);

    if (loaded.state === "loaded") {
      return loaded;
    }
  }

  if (spec.subject) {
    const found = await findBySubject(store, spec.subject, spec.version);

    if (found) {
      const loaded = await store.loadCorpus(found);

      if (loaded.state === "loaded") {
        return loaded;
      }
    }
  }

  return undefined;
}

/** The result-window for a capped excerpt set (resolve/refresh preview or search). */
function excerptWindow(ranked: Ranked): ResultWindow {
  return {
    unit: "excerpts",
    returned: ranked.excerpts.length,
    total: ranked.total,
    truncated: ranked.nextOffset !== undefined,
    ...(ranked.nextOffset !== undefined ? { nextOffset: ranked.nextOffset } : {}),
  };
}

/** A successful corpus result: the summary, a bounded preview of cited excerpts, and the stale flag. */
function okCorpusResult(
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
function reuseResult(action: DocsAction, loaded: LoadedCorpus, stale: boolean): DocsResult {
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
function staleFallback(action: DocsAction, loaded: LoadedCorpus, failed: DocsResult): DocsResult {
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

async function resolveAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
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

async function refreshAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  if (args.corpusId) {
    const store = createCorpusStore(deps.fs, deps.corpusRoot);
    const loaded = await store.loadCorpus(args.corpusId);

    if (loaded.state === "missing") {
      return errorResult("refresh", `docs refresh: corpus ${args.corpusId} not found`);
    }

    if (loaded.state === "corrupt") {
      return corruptResult(
        "refresh",
        `docs refresh: corpus ${args.corpusId} is corrupt: ${loaded.detail}`,
      );
    }

    const corpus = loaded.corpus;
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

    return built.outcome === "ok" ? built : staleFallback("refresh", loaded, built);
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

/** A short reference for an action's error detail when no corpus could be located. */
function targetRef(args: DocsArgs): string {
  return args.corpusId ?? args.subject?.trim() ?? args.url?.trim() ?? "(none)";
}

/**
 * Locates a cached corpus for a query action: by explicit corpusId, else by the predicted id or a
 * by-subject scan. Reads the filesystem only - query actions never touch the network.
 */
async function locateCorpus(args: DocsArgs, deps: ReadyDocsDeps): Promise<LoadResult> {
  const store = createCorpusStore(deps.fs, deps.corpusRoot);

  if (args.corpusId) {
    return store.loadCorpus(args.corpusId);
  }

  const spec = specFrom(args);
  const predicted = predictCorpusId(spec);

  if (predicted) {
    const loaded = await store.loadCorpus(predicted);

    if (loaded.state !== "missing") {
      return loaded;
    }
  }

  if (spec.subject) {
    const found = await findBySubject(store, spec.subject, spec.version);

    if (found) {
      return store.loadCorpus(found);
    }
  }

  return { state: "missing" };
}

async function searchAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
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

  if (loaded.state === "missing") {
    return errorResult(
      "search",
      `docs search: no cached corpus for ${targetRef(args)}; resolve it first`,
    );
  }

  if (loaded.state === "corrupt") {
    return corruptResult(
      "search",
      `docs search: corpus ${loaded.corpusId} is corrupt: ${loaded.detail}`,
    );
  }

  const limit = clamp(args.maxResults, MAX_RESULTS_FLOOR, MAX_RESULTS_CEILING, DEFAULT_MAX_RESULTS);
  const offset = clampOffset(args.offset);
  const ranked = searchCorpus(loaded.pages, query, { offset, limit });
  const stale = isCorpusStale(loaded.corpus, deps.now());

  return {
    action: "search",
    outcome: "ok",
    detail: `docs search: ${ranked.excerpts.length} excerpt(s) for "${query}" in ${loaded.corpus.corpusId}${
      stale ? " (stale)" : ""
    }`,
    corpus: summarizeCorpus(loaded.corpus),
    query: { corpusId: loaded.corpus.corpusId, query, excerpts: ranked.excerpts },
    window: excerptWindow(ranked),
    stale,
    ...(loaded.diagnostics.length > 0 ? { diagnostics: loaded.diagnostics } : {}),
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

async function readAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  if (!args.corpusId) {
    return errorResult("read", "docs read needs a corpusId");
  }

  if (!args.pageId && !args.url?.trim()) {
    return errorResult("read", "docs read needs a pageId or url");
  }

  const store = createCorpusStore(deps.fs, deps.corpusRoot);
  const loaded = await store.loadCorpus(args.corpusId);

  if (loaded.state === "missing") {
    return errorResult("read", `docs read: corpus ${args.corpusId} not found`);
  }

  if (loaded.state === "corrupt") {
    return corruptResult("read", `docs read: corpus ${args.corpusId} is corrupt: ${loaded.detail}`);
  }

  const page = findPage(loaded.pages, args);

  if (!page) {
    return errorResult(
      "read",
      `docs read: page ${args.pageId ?? args.url} not found in ${args.corpusId}`,
    );
  }

  const offset = clampOffset(args.offset);
  const result = readPage(page, { offset });
  const stale = isCorpusStale(loaded.corpus, deps.now());

  return {
    action: "read",
    outcome: "ok",
    detail: `docs read: ${page.pageId} (${result.view.content.length} of ${result.total} chars)${
      stale ? " (stale)" : ""
    }`,
    corpus: summarizeCorpus(loaded.corpus),
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

async function listAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
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

async function statusAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  if (!args.corpusId && !args.subject?.trim() && !args.url?.trim()) {
    return errorResult("status", "docs status needs a corpusId, subject, or url");
  }

  const loaded = await locateCorpus(args, deps);

  if (loaded.state === "missing") {
    return errorResult("status", `docs status: no cached corpus for ${targetRef(args)}`);
  }

  if (loaded.state === "corrupt") {
    return corruptResult(
      "status",
      `docs status: corpus ${loaded.corpusId} is corrupt: ${loaded.detail}`,
    );
  }

  const corpus = loaded.corpus;
  const stale = isCorpusStale(corpus, deps.now());
  const diagnostics = statusDiagnostics(corpus, loaded.diagnostics);

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

/** Runs the docs path against injected deps; the exported tool binds the live deps. */
export async function runDocs(args: DocsArgs, deps: DocsDeps): Promise<string> {
  const missing = missingDependencies(deps);

  if (missing.length > 0) {
    return serializeDocsResult(unavailableResult(args.action, missing));
  }

  const { webFetch, corpusRoot } = deps;

  if (!webFetch || corpusRoot === null) {
    return serializeDocsResult(unavailableResult(args.action, missingDependencies(deps)));
  }

  const ready: ReadyDocsDeps = {
    webFetch,
    ...(deps.webSearch ? { webSearch: deps.webSearch } : {}),
    corpusRoot,
    fs: deps.fs,
    now: deps.now,
  };

  return serializeDocsResult(await dispatch(args, ready));
}

/** Resolves the docs-corpus root through the root policy, or null when it cannot be classified. */
function resolveCorpusRoot(): string | null {
  try {
    return storagePathByName(DOCS_CORPUS_ENTRY);
  } catch {
    return null;
  }
}

/** Live dependencies: the real web_fetch + web_search readers, the classified corpus root, node fs,
 *  the wall clock. docs reads pages and discovers roots ONLY through these seams. */
const liveDeps: DocsDeps = {
  webFetch: ({ url, mode, maxChars }) => runWebFetch({ url, mode, maxChars }, webFetchLiveDeps),
  webSearch: ({ query, count }) => runWebSearch({ query, count }),
  corpusRoot: resolveCorpusRoot(),
  fs: nodeDocsFs,
  now: () => new Date().toISOString(),
};

/** Looks up and caches external documentation (read-only). */
export const docsTool = simpleTool({
  name: "docs",
  description:
    "Look up and cache EXTERNAL documentation for a product, API, library, SDK, or service - the " +
    "documentation-aware companion to web_search/web_fetch. Use it to RESOLVE docs for a subject " +
    "into a cached corpus and to SEARCH/READ that corpus; NOT to crawl, browse, or search the " +
    "workspace's own code. Read-only. Returns JSON: {action, outcome, detail, ...payload}.",
  params: Params,
  readOnly: true,
  execute: (args) => runDocs(args, liveDeps),
});

export type { WebFetchReader, WebSearchReader } from "./readers";
export type { DocsArgs };
export { DOCS_CORPUS_ENTRY, Params as DocsParams };
