/**
 * The docs tool entry: a read-only, model-facing lookup + cache for EXTERNAL documentation
 * (products, APIs, libraries, SDKs, services). It is NOT a crawler, a browser, or a workspace-code
 * search tool. Discovery reuses web_search (Phase 3) and page reads reuse web_fetch (Phase 4); the
 * normalized corpora are persisted under the docs-corpus state root through the root policy. This
 * module owns the tool definition, the live-dependency binding, and the action router; the param
 * contract lives in params.ts, the dependency seam + readiness gate in deps.ts, and the actions in
 * build-actions.ts (resolve/refresh) and query-actions.ts (search/read/list/status). A missing
 * dependency resolves to a typed `unavailable` outcome rather than throwing the turn.
 *
 * Responsible for: the docs tool entry - the tool definition, the live deps, and the action
 * router over resolve/refresh/search/read/list/status.
 * Not for: executing the actions - build-actions.ts and query-actions.ts own those.
 */

import { storagePathByName } from "@belay/session/node-paths";
import { simpleTool } from "../shared";
import { runWebFetch, webFetchLiveDeps } from "../web-fetch/web-fetch";
import { runWebSearch } from "../web-search";
import { refreshAction, resolveAction } from "./build-actions";
import { nodeDocsFs } from "./corpus-store";
import { type DocsDeps, missingDependencies, type ReadyDocsDeps } from "./deps";
import { type DocsResult, serializeDocsResult, unavailableResult } from "./envelope";
import { type DocsArgs, DocsParams } from "./params";
import { listAction, readAction, searchAction, statusAction } from "./query-actions";

/** The docs-corpus storage inventory name owned by the root policy (`@belay/session/node-paths`). */
export const DOCS_CORPUS_ENTRY = "docs-corpus";

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
    "workspace's own code. Reach for it BEFORE reverse-engineering a third-party tool's behavior " +
    "from error messages: when configuring, integrating, or debugging a library/SDK/service, the " +
    "canonical answer - especially version-specific behavior or how two tools interact - is in the " +
    "official docs, not in inference. Read-only. Returns JSON: {action, outcome, detail, ...payload}.",
  params: DocsParams,
  readOnly: true,
  execute: (args) => runDocs(args, liveDeps),
});
