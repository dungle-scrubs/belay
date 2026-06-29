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
  corpusIdFor,
  DOCS_CORPUS_VERSION,
  type PageDiagnostic,
  staleAfterFrom,
} from "./corpus";
import { createCorpusStore, type DocsFs, nodeDocsFs, summarizeCorpus } from "./corpus-store";
import { type DiscoveryResult, resolveCandidates } from "./discovery";
import {
  corpusResult,
  corruptResult,
  DOCS_ACTIONS,
  type DocsAction,
  type DocsResult,
  errorResult,
  notImplementedResult,
  serializeDocsResult,
  unavailableResult,
} from "./envelope";
import { fetchPages } from "./fetch-pages";
import type { WebFetchReader, WebSearchReader } from "./readers";

const MAX_PAGES_FLOOR = 1;
const MAX_PAGES_CEILING = 200;
const DEFAULT_MAX_PAGES = 40;

const MAX_RESULTS_FLOOR = 1;
const MAX_RESULTS_CEILING = 50;
const DEFAULT_MAX_RESULTS = 8;

/** web_fetch strategy docs reads pages with: "auto" lets web_fetch own the static/rendered ladder. */
const DEFAULT_FETCH_MODE = "auto" as const;

/** Character cap docs asks web_fetch for per page (web_fetch's own default). */
const DOCS_PAGE_MAX_CHARS = 12_000;

/** How many hours a freshly built corpus stays fresh before Phase 5 considers it stale. */
const DOCS_FRESHNESS_HOURS = 24;

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
 * Routes one action to its service seam. `resolve`/`refresh` build a corpus end-to-end (Phases 3-4);
 * the query actions (`search`/`read`/`list`/`status`) land in Phase 6 and report `not-implemented`
 * until then. The dependency gate has already passed by here, so web_fetch and the corpus root exist.
 */
async function dispatch(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  switch (args.action) {
    case "resolve":
      return resolveAction(args, deps);
    case "refresh":
      return refreshAction(args, deps);
    case "search":
      return notImplementedResult("search");
    case "read":
      return notImplementedResult("read");
    case "list":
      return notImplementedResult("list");
    case "status":
      return notImplementedResult("status");
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

  return corpusResult(
    action,
    detail,
    summarizeCorpus(corpus),
    buildDiagnostics(discovery, fetched.failed, skipped),
  );
}

async function resolveAction(args: DocsArgs, deps: ReadyDocsDeps): Promise<DocsResult> {
  if (!args.subject?.trim() && !args.url?.trim()) {
    return errorResult("resolve", "docs resolve needs a subject or a url");
  }

  return buildAndStore("resolve", specFrom(args), deps);
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

    return buildAndStore(
      "refresh",
      {
        subject: corpus.subject,
        url: corpus.source.rootUrl,
        ...(corpus.source.version ? { version: corpus.source.version } : {}),
        maxPages: corpus.policy.maxPages,
      },
      deps,
    );
  }

  if (!args.subject?.trim() && !args.url?.trim()) {
    return errorResult("refresh", "docs refresh needs a corpusId, subject, or url");
  }

  return buildAndStore("refresh", specFrom(args), deps);
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
