/**
 * Responsible for: the `source-recall` FastAPI daemon adapter (M3/M4) - the first concrete
 * {@link SourceRecallProvider}. It speaks the documented daemon API (`/health`, `/repos`, `/query`,
 * `/status`, `/refresh`; hybrid BM25+vector chunk search) over the injected {@link SourceRecallHttp}
 * transport and normalizes every answer through the pure `source-recall-mapping` functions. Non-2xx
 * codes the daemon documents (400 multi-repo needs a repo, 404 repo-not-found, 429 refresh
 * rate-limited) become typed provider errors, so the tool degrades to a visible diagnostic rather
 * than crashing a turn. Index lifecycle stays explicit and user-directed: this adapter never
 * auto-indexes - it only queries an already-served repo and refreshes on explicit request (M4).
 *
 * Not for: the mapping (source-recall-mapping.ts), the transport (http.ts), or config (config.ts).
 */

import type {
  SourceRecallCapability,
  SourceRecallFreshness,
  SourceRecallReadiness,
} from "@trevor/session";
import { Effect } from "effect";
import {
  MAX_SNIPPET_CHARS,
  type SourceRecallDiscovery,
  type SourceRecallProvider,
  type SourceRecallQueryAnswer,
  type SourceRecallQueryInput,
  type SourceRecallRefreshAnswer,
  type SourceRecallStatusSnapshot,
} from "./contract";
import {
  SourceRecallProtocolError,
  type SourceRecallProviderError,
  SourceRecallRateLimitedError,
  SourceRecallRepoAmbiguousError,
  SourceRecallRepoNotFoundError,
  SourceRecallRepoNotReadyError,
} from "./errors";
import { getJson, type HttpResponse, parseJson, request, type SourceRecallHttp } from "./http";
import {
  freshnessFromStatus,
  isQueryBody,
  isReposBody,
  repoStatusFromRepoInfo,
  type SrHealthBody,
  type SrQueryBody,
  type SrRefreshBody,
  type SrReposBody,
  type SrStatusBody,
  toResultItem,
} from "./source-recall-mapping";

export interface SourceRecallAdapterDeps {
  readonly id: string;
  readonly http: SourceRecallHttp;
  /** Wall clock for stale computation; injected so tests are deterministic. */
  readonly nowMs?: () => number;
}

/** Builds the `source-recall` daemon adapter over an injected HTTP transport. */
export function createSourceRecallAdapter(deps: SourceRecallAdapterDeps): SourceRecallProvider {
  const { id, http } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());

  const discover = (): Effect.Effect<SourceRecallDiscovery, SourceRecallProviderError> =>
    getJson<SrHealthBody>(http, "/health").pipe(
      Effect.flatMap((health) =>
        getJson<SrReposBody>(http, "/repos").pipe(
          Effect.map((repos): SourceRecallDiscovery => {
            const hasVectors = repos.repos.some((r) => r.vector_count > 0);
            const capabilities: SourceRecallCapability[] = ["chunk_search", "status", "refresh"];
            if (hasVectors) {
              capabilities.push("semantic_index");
            }
            const readiness: SourceRecallReadiness =
              health.ok && repos.repos.length > 0 ? "ready" : "unready";
            return {
              reachable: true,
              readiness,
              capabilities,
              note: `source-recall ok, ${repos.repos.length} repo(s), up ${Math.round(health.uptime_s)}s`,
            };
          }),
        ),
      ),
    );

  const status = (
    repo?: string,
  ): Effect.Effect<SourceRecallStatusSnapshot, SourceRecallProviderError> => {
    const capabilities: readonly SourceRecallCapability[] = [
      "chunk_search",
      "semantic_index",
      "status",
      "refresh",
    ];
    if (repo) {
      // A named repo: /status carries the index timestamp (freshness), so prefer it.
      return request(http, `/status?repo=${encodeURIComponent(repo)}`).pipe(
        Effect.flatMap((response) => {
          const failure = domainError(response, repo);
          if (failure) {
            return Effect.fail(failure);
          }
          return parseJson<SrStatusBody>(response).pipe(
            Effect.map((body): SourceRecallStatusSnapshot => {
              const freshness = freshnessFromStatus(body, nowMs());
              const readiness: SourceRecallReadiness = body.chunk_count > 0 ? "ready" : "unready";
              return {
                capabilities,
                repos: [{ name: repo, readiness, freshness }],
              };
            }),
          );
        }),
      );
    }
    return getJson<SrReposBody>(http, "/repos").pipe(
      Effect.flatMap((body) => {
        if (!isReposBody(body)) {
          return Effect.fail(
            new SourceRecallProtocolError({ detail: "expected a { repos: [...] } body" }),
          );
        }
        return Effect.succeed<SourceRecallStatusSnapshot>({
          capabilities,
          repos: body.repos.map(repoStatusFromRepoInfo),
        });
      }),
    );
  };

  const query = (
    input: SourceRecallQueryInput,
  ): Effect.Effect<SourceRecallQueryAnswer, SourceRecallProviderError> =>
    request(http, "/query", {
      method: "POST",
      body: {
        question: input.query,
        top_k: input.topK,
        ...(input.repo ? { repo: input.repo } : {}),
      },
    }).pipe(
      Effect.flatMap((response) => {
        const failure = domainError(response, input.repo);
        if (failure) {
          return Effect.fail(failure);
        }
        return parseJson<SrQueryBody>(response).pipe(
          Effect.flatMap((body) => {
            if (!isQueryBody(body)) {
              return Effect.fail(
                new SourceRecallProtocolError({ detail: "expected a { results: [...] } body" }),
              );
            }
            return finishQuery(input, body);
          }),
        );
      }),
    );

  /** Attaches best-effort freshness (a failed status call degrades to null freshness, never an error). */
  const finishQuery = (
    input: SourceRecallQueryInput,
    body: SrQueryBody,
  ): Effect.Effect<SourceRecallQueryAnswer, SourceRecallProviderError> => {
    const mapped = body.results.map((row) =>
      toResultItem(id, row, input.repo ?? null, MAX_SNIPPET_CHARS),
    );
    const answer: Omit<SourceRecallQueryAnswer, "freshness"> = {
      items: mapped.map((m) => m.item),
      repo: input.repo ?? null,
      latencyMs: Math.round(body.query_ms),
      truncated: mapped.some((m) => m.truncated),
    };
    return freshnessBestEffort(input.repo).pipe(
      Effect.map((freshness): SourceRecallQueryAnswer => ({ ...answer, freshness })),
    );
  };

  const freshnessBestEffort = (repo?: string): Effect.Effect<SourceRecallFreshness | null> =>
    request(http, repo ? `/status?repo=${encodeURIComponent(repo)}` : "/status").pipe(
      Effect.flatMap((response) =>
        response.ok
          ? parseJson<SrStatusBody>(response).pipe(
              Effect.map((body) => freshnessFromStatus(body, nowMs())),
            )
          : Effect.succeed<SourceRecallFreshness | null>(null),
      ),
      Effect.catchAll(() => Effect.succeed<SourceRecallFreshness | null>(null)),
    );

  const refresh = (
    repo?: string,
  ): Effect.Effect<SourceRecallRefreshAnswer, SourceRecallProviderError> =>
    request(http, repo ? `/refresh?repo=${encodeURIComponent(repo)}` : "/refresh", {
      method: "POST",
    }).pipe(
      Effect.flatMap((response) => {
        if (response.status === 429) {
          return Effect.fail(
            new SourceRecallRateLimitedError({
              detail: detailOf(response, "refresh rate limited"),
            }),
          );
        }
        const failure = domainError(response, repo);
        if (failure) {
          return Effect.fail(failure);
        }
        return parseJson<SrRefreshBody>(response).pipe(
          Effect.map(
            (r): SourceRecallRefreshAnswer => ({
              repo: repo ?? null,
              filesUpdated: r.files_updated,
              refreshMs: Math.round(r.refresh_ms),
            }),
          ),
        );
      }),
    );

  return { id, kind: "source-recall", discover, status, query, refresh };
}

/** Reads a FastAPI `{ detail }` error body into a bounded string, or a fallback for a non-JSON body. */
function detailOf(response: HttpResponse, fallback: string): string {
  try {
    const parsed = JSON.parse(response.body) as { detail?: unknown };
    if (typeof parsed.detail === "string") {
      return parsed.detail.length > 200 ? `${parsed.detail.slice(0, 200)}…` : parsed.detail;
    }
  } catch {
    // non-JSON error body; fall through
  }
  return fallback;
}

/**
 * Classifies a non-2xx daemon response into a typed domain error, or null for a 2xx. The daemon
 * documents: 400 (multi-repo query with no `repo`), 404 (repo not found), and - on a repo that
 * exists but has an empty index - a 400/detail we surface as not-ready. A 429 is handled at the
 * refresh call site (only refresh is rate-limited).
 */
function domainError(
  response: HttpResponse,
  repo: string | undefined,
): SourceRecallProviderError | null {
  if (response.ok) {
    return null;
  }
  const detail = detailOf(response, `daemon returned status ${response.status}`);
  if (response.status === 404) {
    return new SourceRecallRepoNotFoundError({ repo: repo ?? detail });
  }
  if (response.status === 400) {
    // The multi-repo query error names the available repos; surface it as an ambiguity signal.
    if (/multiple repos/i.test(detail)) {
      return new SourceRecallRepoAmbiguousError({ available: parseAvailableRepos(detail) });
    }
    return new SourceRecallRepoNotReadyError({ repo: repo ?? "?", detail });
  }
  return new SourceRecallProtocolError({ detail });
}

/** Extracts the repo names from the daemon's "Multiple repos loaded. Specify 'repo': one of [...]" detail. */
function parseAvailableRepos(detail: string): readonly string[] {
  const match = detail.match(/\[([^\]]*)\]/);
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}
