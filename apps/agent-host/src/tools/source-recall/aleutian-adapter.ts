/**
 * Responsible for: the Aleutian Trace adapter (M5/M6) - the SECOND concrete
 * {@link SourceRecallProvider}, behind the same contract as the `source-recall` daemon. It discovers
 * Aleutian's capabilities over `/v1/trace/{health,ready,tools}` (Aleutian is a structural graph +
 * symbol + context engine, so discovery decides what it advertises - it is NOT pretended to be only
 * chunk search), initializes a project graph (`/init`, cached per project root), and maps a
 * conceptual query onto `/context` + `/symbol/:id` so Aleutian results normalize into the same cited
 * source-recall result items. It does NOT route Trevor's model turn through Aleutian's
 * OpenAI-compatible proxy - Aleutian is used purely as a retrieval provider (M6 REFACTOR / Gate 3->4).
 *
 * Not for: the pure mapping (aleutian-mapping.ts), the transport (http.ts), or config (config.ts).
 */

import type { SourceRecallFreshness } from "@trevor/session";
import { Effect } from "effect";
import {
  type AlContextBody,
  type AlHealthBody,
  type AlInitBody,
  type AlReadyBody,
  type AlSymbolBody,
  type AlToolsBody,
  isErrorBody,
  normalizeCapabilities,
  symbolToResultItem,
} from "./aleutian-mapping";
import type {
  SourceRecallDiscovery,
  SourceRecallProvider,
  SourceRecallQueryAnswer,
  SourceRecallQueryInput,
  SourceRecallRefreshAnswer,
  SourceRecallStatusSnapshot,
} from "./contract";
import {
  SourceRecallCapabilityMissingError,
  SourceRecallNotInitializedError,
  SourceRecallProtocolError,
  type SourceRecallProviderError,
} from "./errors";
import { getJson, parseJson, request, type SourceRecallHttp } from "./http";

const MAX_SNIPPET_CHARS = 1200;
/** Trace's `/context` token budget; a query never floods context - candidates are cited (D-003). */
const DEFAULT_TOKEN_BUDGET = 8000;

export interface AleutianAdapterDeps {
  readonly id: string;
  readonly http: SourceRecallHttp;
  readonly transport: "http" | "mcp";
  /** The project root Aleutian initializes a graph for (from config or the active query). */
  readonly projectRoot?: string;
  /** Languages to parse on init; defaults to Trace's own default when absent. */
  readonly languages?: readonly string[];
}

/** One initialized graph plus the freshness captured at init/refresh time. */
interface GraphEntry {
  readonly graphId: string;
  readonly freshness: SourceRecallFreshness;
}

/** Builds the Aleutian Trace adapter over an injected HTTP transport. */
export function createAleutianAdapter(deps: AleutianAdapterDeps): SourceRecallProvider {
  const { id, http, transport } = deps;
  // Per-project graph cache: init is expensive, so a graph is reused across queries until refreshed.
  const graphs = new Map<string, GraphEntry>();

  // Configured project mapping is the authority (M4/M8); the active project root is only a fallback.
  const resolveRoot = (projectRoot: string | undefined): string | undefined =>
    deps.projectRoot ?? projectRoot;

  const repoName = (projectRoot: string | undefined): string => {
    const root = resolveRoot(projectRoot);
    return root ? (root.split("/").filter(Boolean).pop() ?? "project") : "project";
  };

  const discover = (): Effect.Effect<SourceRecallDiscovery, SourceRecallProviderError> => {
    if (transport === "mcp") {
      const caps = normalizeCapabilities({
        transport: "mcp",
        reachable: true,
        ready: true,
        weaviateOk: false,
        tools: [],
      });
      return Effect.succeed({
        reachable: true,
        readiness: caps.readiness,
        capabilities: caps.capabilities,
        note: "aleutian trace-mcp (no HTTP discovery)",
      });
    }
    return getJson<AlHealthBody>(http, "/v1/trace/health").pipe(
      Effect.flatMap((health) =>
        getJson<AlReadyBody>(http, "/v1/trace/ready").pipe(
          Effect.flatMap((ready) =>
            discoverTools().pipe(
              Effect.map((tools): SourceRecallDiscovery => {
                const caps = normalizeCapabilities({
                  transport: "http",
                  reachable: health.status === "healthy" || health.status === "degraded",
                  ready: ready.ready,
                  weaviateOk: ready.weaviate_ok === true,
                  tools,
                });
                return {
                  reachable: true,
                  readiness: caps.readiness,
                  capabilities: caps.capabilities,
                  note: `aleutian ${health.status}, ${ready.graph_count} graph(s), weaviate ${ready.weaviate_ok ? "ok" : "down"}`,
                };
              }),
            ),
          ),
        ),
      ),
    );
  };

  /** Tool discovery is best-effort: a `/tools` failure (older Trace) degrades to "unknown", not an error. */
  const discoverTools = (): Effect.Effect<readonly string[], SourceRecallProviderError> =>
    getJson<AlToolsBody>(http, "/v1/trace/tools").pipe(
      Effect.map((body) => body.tools.map((t) => t.name)),
      Effect.catchAll(() => Effect.succeed([] as readonly string[])),
    );

  const status = (): Effect.Effect<SourceRecallStatusSnapshot, SourceRecallProviderError> =>
    discover().pipe(
      Effect.map((d): SourceRecallStatusSnapshot => {
        const cached = deps.projectRoot ? graphs.get(deps.projectRoot) : undefined;
        return {
          capabilities: d.capabilities,
          repos: [
            {
              name: repoName(undefined),
              readiness: d.readiness,
              freshness: cached?.freshness ?? emptyFreshness(),
            },
          ],
        };
      }),
    );

  /** Ensures a graph exists for the project root (init on first use), caching the id + freshness. */
  const ensureGraph = (
    projectRoot: string | undefined,
  ): Effect.Effect<GraphEntry, SourceRecallProviderError> => {
    const root = resolveRoot(projectRoot);
    if (!root) {
      return Effect.fail(
        new SourceRecallNotInitializedError({ detail: "no project root configured for Aleutian" }),
      );
    }
    const cached = graphs.get(root);
    if (cached) {
      return Effect.succeed(cached);
    }
    return initGraph(root);
  };

  const initGraph = (root: string): Effect.Effect<GraphEntry, SourceRecallProviderError> =>
    request(http, "/v1/trace/init", {
      method: "POST",
      body: { project_root: root, ...(deps.languages ? { languages: deps.languages } : {}) },
    }).pipe(
      Effect.flatMap((response) => {
        if (!response.ok) {
          return Effect.fail(errorFrom(response.body, response.status));
        }
        return parseJson<AlInitBody>(response).pipe(
          Effect.map((body): GraphEntry => {
            const entry: GraphEntry = {
              graphId: body.graph_id,
              freshness: {
                indexedAt: null,
                lastCommit: null,
                fileCount: body.files_parsed,
                chunkCount: body.symbols_extracted,
                vectorCount: null,
                stale: false,
              },
            };
            graphs.set(root, entry);
            return entry;
          }),
        );
      }),
    );

  const query = (
    input: SourceRecallQueryInput,
  ): Effect.Effect<SourceRecallQueryAnswer, SourceRecallProviderError> => {
    if (transport === "mcp") {
      return Effect.fail(
        new SourceRecallCapabilityMissingError({
          detail: "aleutian mcp transport: query is not wired in the first cut; use http transport",
        }),
      );
    }
    const startedAt = Date.now();
    return ensureGraph(input.projectRoot).pipe(
      Effect.flatMap((graph) =>
        assembleContext(graph.graphId, input.query).pipe(
          Effect.flatMap((context) =>
            resolveSymbols(context.symbols_included.slice(0, input.topK)).pipe(
              Effect.map(
                (resolved): SourceRecallQueryAnswer => ({
                  items: resolved.map((r) => r.item),
                  repo: repoName(input.projectRoot),
                  freshness: graph.freshness,
                  latencyMs: Date.now() - startedAt,
                  truncated: resolved.some((r) => r.truncated),
                }),
              ),
            ),
          ),
        ),
      ),
    );
  };

  const assembleContext = (
    graphId: string,
    queryText: string,
  ): Effect.Effect<AlContextBody, SourceRecallProviderError> =>
    request(http, "/v1/trace/context", {
      method: "POST",
      body: { graph_id: graphId, query: queryText, token_budget: DEFAULT_TOKEN_BUDGET },
    }).pipe(
      Effect.flatMap((response) => {
        if (!response.ok) {
          return Effect.fail(errorFrom(response.body, response.status));
        }
        return parseJson<AlContextBody>(response).pipe(
          Effect.flatMap((body) =>
            Array.isArray(body.symbols_included)
              ? Effect.succeed(body)
              : Effect.fail(
                  new SourceRecallProtocolError({
                    detail: "context body missing symbols_included",
                  }),
                ),
          ),
        );
      }),
    );

  /** Resolves each included symbol id to a cited result item, skipping any that 404/fail (best-effort). */
  const resolveSymbols = (ids: readonly string[]) =>
    Effect.forEach(
      ids.map((symbolId, index) => ({ symbolId, index })),
      ({ symbolId, index }) =>
        request(http, `/v1/trace/symbol/${encodeURIComponent(symbolId)}`).pipe(
          Effect.flatMap((response) =>
            response.ok ? parseJson<AlSymbolBody>(response) : Effect.succeed({ symbol: null }),
          ),
          Effect.map((body) =>
            body.symbol
              ? symbolToResultItem(id, body.symbol, index, ids.length, MAX_SNIPPET_CHARS)
              : null,
          ),
          Effect.catchAll(() => Effect.succeed(null)),
        ),
    ).pipe(
      Effect.map((resolved) => resolved.filter((r): r is NonNullable<typeof r> => r !== null)),
    );

  const refresh = (
    _repo?: string,
    projectRoot?: string,
  ): Effect.Effect<SourceRecallRefreshAnswer, SourceRecallProviderError> => {
    if (transport === "mcp") {
      return Effect.fail(
        new SourceRecallCapabilityMissingError({
          detail:
            "aleutian mcp transport: refresh is not wired in the first cut; use http transport",
        }),
      );
    }
    const root = resolveRoot(projectRoot);
    if (!root) {
      return Effect.fail(
        new SourceRecallNotInitializedError({ detail: "no project root configured for Aleutian" }),
      );
    }
    const startedAt = Date.now();
    // A re-init IS the refresh (Trace re-parses and rebuilds the graph); drop the cache first.
    graphs.delete(root);
    return initGraph(root).pipe(
      Effect.map(
        (entry): SourceRecallRefreshAnswer => ({
          repo: repoName(projectRoot),
          filesUpdated: entry.freshness.fileCount ?? 0,
          refreshMs: Date.now() - startedAt,
        }),
      ),
    );
  };

  return { id, kind: "aleutian", discover, status, query, refresh };
}

/** Maps an Aleutian `{ error, code, details }` body (or a raw non-JSON body) to a typed provider error. */
function errorFrom(body: string, httpStatus: number): SourceRecallProviderError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new SourceRecallProtocolError({ detail: `non-JSON error body (status ${httpStatus})` });
  }
  if (!isErrorBody(parsed)) {
    return new SourceRecallProtocolError({
      detail: `unexpected error body (status ${httpStatus})`,
    });
  }
  const detail = boundedDetail(parsed.error ?? parsed.code ?? `status ${httpStatus}`);
  if (parsed.code === "GRAPH_NOT_INITIALIZED") {
    return new SourceRecallNotInitializedError({ detail });
  }
  return new SourceRecallProtocolError({ detail });
}

function boundedDetail(detail: string): string {
  return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
}

function emptyFreshness(): SourceRecallFreshness {
  return {
    indexedAt: null,
    lastCommit: null,
    fileCount: null,
    chunkCount: null,
    vectorCount: null,
    stale: false,
  };
}
