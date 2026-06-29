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
import { type DocsFs, nodeDocsFs } from "./corpus-store";
import {
  DOCS_ACTIONS,
  type DocsResult,
  notImplementedResult,
  serializeDocsResult,
  unavailableResult,
} from "./envelope";

const MAX_PAGES_FLOOR = 1;
const MAX_PAGES_CEILING = 200;
const DEFAULT_MAX_PAGES = 40;

const MAX_RESULTS_FLOOR = 1;
const MAX_RESULTS_CEILING = 50;
const DEFAULT_MAX_RESULTS = 8;

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

/**
 * The page reader docs reuses (Phase 4): read one URL into web_fetch's bounded, attributable JSON
 * envelope. Live deps bind it to `runWebFetch`; tests inject a fake. Absent means the dependency gate
 * reports the tool unavailable.
 */
export type WebFetchReader = (input: {
  readonly url: string;
  readonly mode?: "auto" | "static" | "rendered";
  readonly maxChars?: number;
}) => Promise<string>;

/**
 * The discovery reader docs reuses (Phase 3): search the web for documentation pages, returning
 * web_search's JSON envelope. Optional - discovery is a later phase, so the gate does not require it.
 */
export type WebSearchReader = (input: {
  readonly query: string;
  readonly count?: number;
}) => Promise<string>;

/** Injectable dependencies, so the whole docs path is deterministic under test. */
export interface DocsDeps {
  readonly webFetch?: WebFetchReader;
  readonly webSearch?: WebSearchReader;
  /** The absolute docs-corpus root, or null when the root policy cannot classify it. */
  readonly corpusRoot: string | null;
  readonly fs: DocsFs;
  readonly now: () => string;
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
 * Routes one action to its service seam. Each action's real behavior lands in a later phase
 * (3 resolve/discovery, 4 reads, 5 refresh/freshness, 6 search/read, 7 UI); until then every action
 * reports a typed `not-implemented` outcome. The dependency gate has already passed by here.
 */
async function dispatch(args: DocsArgs, deps: DocsDeps): Promise<DocsResult> {
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

async function resolveAction(_args: DocsArgs, _deps: DocsDeps): Promise<DocsResult> {
  return notImplementedResult("resolve");
}

async function refreshAction(_args: DocsArgs, _deps: DocsDeps): Promise<DocsResult> {
  return notImplementedResult("refresh");
}

async function searchAction(_args: DocsArgs, _deps: DocsDeps): Promise<DocsResult> {
  return notImplementedResult("search");
}

async function readAction(_args: DocsArgs, _deps: DocsDeps): Promise<DocsResult> {
  return notImplementedResult("read");
}

async function listAction(_args: DocsArgs, _deps: DocsDeps): Promise<DocsResult> {
  return notImplementedResult("list");
}

async function statusAction(_args: DocsArgs, _deps: DocsDeps): Promise<DocsResult> {
  return notImplementedResult("status");
}

/** Runs the docs path against injected deps; the exported tool binds the live deps. */
export async function runDocs(args: DocsArgs, deps: DocsDeps): Promise<string> {
  const missing = missingDependencies(deps);

  if (missing.length > 0) {
    return serializeDocsResult(unavailableResult(args.action, missing));
  }

  return serializeDocsResult(await dispatch(args, deps));
}

/** Resolves the docs-corpus root through the root policy, or null when it cannot be classified. */
function resolveCorpusRoot(): string | null {
  try {
    return storagePathByName(DOCS_CORPUS_ENTRY);
  } catch {
    return null;
  }
}

/** Live dependencies: the real web_fetch reader, the classified corpus root, node fs, the wall clock. */
const liveDeps: DocsDeps = {
  webFetch: ({ url, mode, maxChars }) => runWebFetch({ url, mode, maxChars }, webFetchLiveDeps),
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

export type { DocsArgs };
export { DOCS_CORPUS_ENTRY, Params as DocsParams };
