/**
 * Responsible for: source-recall provider selection + result shaping (plan 38 M8) - building the
 * concrete adapters from config, ordering them deterministically by priority, selecting one (explicit
 * id or highest priority), applying transport-error fallback across enabled providers, and turning a
 * provider answer OR a typed provider error into the visible {@link SourceRecallResult} /
 * IndexStatus / RefreshResult wire envelope. The registry NEVER fails: a missing/disabled/unreachable
 * backend becomes a structured `unavailable`/`error` result, never a turn crash (Gate 4->5). Selection
 * is deterministic and inspectable (M8 REFACTOR): `inspect()` returns the redacted provider order.
 *
 * Not for: config parsing (config.ts), the adapters (source-recall-adapter.ts / aleutian-adapter.ts),
 * or the model-facing tool schemas (tools.ts).
 */

import type {
  SourceRecallDiagnostic,
  SourceRecallIndexStatus,
  SourceRecallRefreshResult,
  SourceRecallResult,
} from "@trevor/session";
import { Effect } from "effect";
import { createAleutianAdapter } from "./aleutian-adapter";
import {
  type RedactedSourceRecallProvider,
  redactSourceRecallProvider,
  type SourceRecallConfig,
  type SourceRecallProviderConfig,
} from "./config";
import type { SourceRecallProvider, SourceRecallQueryInput } from "./contract";
import { diagnosticOf, type SourceRecallProviderError } from "./errors";
import type { SourceRecallFetch } from "./http";
import { createSourceRecallAdapter } from "./source-recall-adapter";

/** Hard ceiling on results returned regardless of the requested top_k (bounds context flooding). */
export const MAX_RESULTS = 20;
/** Default top_k when the model does not specify one (mirrors source-recall's own default). */
export const DEFAULT_TOP_K = 8;

export interface SourceRecallRegistryDeps {
  readonly fetch?: SourceRecallFetch;
  readonly nowMs?: () => number;
}

/** One selectable provider: its config plus the constructed adapter. */
interface Entry {
  readonly config: SourceRecallProviderConfig;
  readonly adapter: SourceRecallProvider;
}

export interface SourceRecallRegistry {
  /** True when at least one enabled provider is configured. */
  readonly hasEnabledProvider: boolean;
  /** The redacted, priority-ordered provider list for diagnostics (`/doctor`, debug). */
  inspect(): readonly RedactedSourceRecallProvider[];
  query(input: SourceRecallQueryInput, explicitId?: string): Effect.Effect<SourceRecallResult>;
  status(repo?: string, explicitId?: string): Effect.Effect<SourceRecallIndexStatus>;
  refresh(
    repo?: string,
    projectRoot?: string,
    explicitId?: string,
  ): Effect.Effect<SourceRecallRefreshResult>;
}

/** Builds a registry from normalized config + injected transport deps (fetch defaults to the global). */
export function createSourceRecallRegistry(
  config: SourceRecallConfig,
  deps: SourceRecallRegistryDeps = {},
): SourceRecallRegistry {
  const fetch = deps.fetch ?? (globalThis.fetch as unknown as SourceRecallFetch);
  const nowMs = deps.nowMs ?? (() => Date.now());

  // Enabled providers, deterministically ordered by (priority, id) so selection is stable.
  const entries: readonly Entry[] = [...config.providers]
    .filter((p) => p.enabled)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((provider) => ({ config: provider, adapter: buildAdapter(provider, fetch, nowMs) }));

  const inspect = (): readonly RedactedSourceRecallProvider[] =>
    [...config.providers]
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map(redactSourceRecallProvider);

  /** Resolves the ordered candidate list for a call: one explicit provider, or all enabled by priority. */
  const candidates = (explicitId?: string): { entries: readonly Entry[]; unknownId: boolean } => {
    if (explicitId) {
      const found = entries.find((e) => e.config.id === explicitId);
      return { entries: found ? [found] : [], unknownId: !found };
    }
    return { entries, unknownId: false };
  };

  const query = (
    input: SourceRecallQueryInput,
    explicitId?: string,
  ): Effect.Effect<SourceRecallResult> => {
    const { entries: chain, unknownId } = candidates(explicitId);
    if (chain.length === 0) {
      return Effect.succeed(unavailableQuery(input, unavailabilityDiag(explicitId, unknownId)));
    }
    const topK = clampTopK(input.topK);
    return attemptChain(
      chain,
      (entry) =>
        entry.adapter
          .query({ ...input, topK })
          .pipe(Effect.map((answer) => queryResultOf(entry, input, answer, topK))),
      // Fallback only happens without an explicit provider; on total failure return the last diagnostic.
      (entry, error) => Effect.succeed(queryErrorResult(entry, input, error)),
      Boolean(explicitId),
    );
  };

  const status = (repo?: string, explicitId?: string): Effect.Effect<SourceRecallIndexStatus> => {
    const { entries: chain, unknownId } = candidates(explicitId);
    if (chain.length === 0) {
      return Effect.succeed({
        status: "unavailable",
        providerId: null,
        providerKind: null,
        capabilities: [],
        repos: [],
        diagnostics: [unavailabilityDiag(explicitId, unknownId)],
      });
    }
    return attemptChain(
      chain,
      (entry) =>
        entry.adapter.status(repo).pipe(
          Effect.map(
            (snapshot): SourceRecallIndexStatus => ({
              status: snapshot.repos.some((r) => r.readiness === "ready") ? "ok" : "unready",
              providerId: entry.config.id,
              providerKind: entry.config.kind,
              capabilities: snapshot.capabilities,
              repos: snapshot.repos,
              diagnostics: [],
            }),
          ),
        ),
      (entry, error): Effect.Effect<SourceRecallIndexStatus> =>
        Effect.succeed({
          status: "error",
          providerId: entry.config.id,
          providerKind: entry.config.kind,
          capabilities: [],
          repos: [],
          diagnostics: [diagnosticOf(error)],
        }),
      Boolean(explicitId),
    );
  };

  const refresh = (
    repo?: string,
    projectRoot?: string,
    explicitId?: string,
  ): Effect.Effect<SourceRecallRefreshResult> => {
    const { entries: chain, unknownId } = candidates(explicitId);
    if (chain.length === 0) {
      return Effect.succeed({
        status: "unavailable",
        providerId: null,
        providerKind: null,
        repo: repo ?? null,
        filesUpdated: null,
        refreshMs: null,
        diagnostics: [unavailabilityDiag(explicitId, unknownId)],
      });
    }
    return attemptChain(
      chain,
      (entry) =>
        entry.adapter.refresh(repo ?? entry.config.repo, projectRoot).pipe(
          Effect.map(
            (answer): SourceRecallRefreshResult => ({
              status: "ok",
              providerId: entry.config.id,
              providerKind: entry.config.kind,
              repo: answer.repo,
              filesUpdated: answer.filesUpdated,
              refreshMs: answer.refreshMs,
              diagnostics: [],
            }),
          ),
        ),
      (entry, error): Effect.Effect<SourceRecallRefreshResult> =>
        Effect.succeed(refreshErrorResult(entry, repo, error)),
      Boolean(explicitId),
    );
  };

  /** Result shaping for a successful query answer (freshness stale -> `stale` status). */
  const queryResultOf = (
    entry: Entry,
    input: SourceRecallQueryInput,
    answer: import("./contract").SourceRecallQueryAnswer,
    topK: number,
  ): SourceRecallResult => {
    const items = answer.items.slice(0, MAX_RESULTS);
    const status: SourceRecallResult["status"] =
      items.length === 0 ? "no_results" : answer.freshness?.stale ? "stale" : "ok";
    return {
      status,
      providerId: entry.config.id,
      providerKind: entry.config.kind,
      query: input.query,
      repo: answer.repo,
      results: items,
      freshness: answer.freshness,
      latencyMs: answer.latencyMs,
      capped: answer.items.length > MAX_RESULTS || answer.items.length >= topK,
      truncated: answer.truncated,
      diagnostics: [],
    };
  };

  return { hasEnabledProvider: entries.length > 0, inspect, query, status, refresh };
}

/**
 * Runs a candidate chain: try each provider in order; a TRANSPORT failure (unreachable/timeout) with
 * no explicit provider falls through to the next; any other error - or an explicit provider - stops
 * with `onError`. Returns the last attempt's result when the chain is exhausted.
 */
function attemptChain<R>(
  chain: readonly Entry[],
  run: (entry: Entry) => Effect.Effect<R, SourceRecallProviderError>,
  onError: (entry: Entry, error: SourceRecallProviderError) => Effect.Effect<R>,
  explicit: boolean,
): Effect.Effect<R> {
  const step = (index: number): Effect.Effect<R> => {
    const entry = chain[index];
    if (!entry) {
      // Unreachable: the loop always resolves via onError on the last entry.
      throw new Error("empty source-recall chain");
    }
    return run(entry).pipe(
      Effect.catchAll((error: SourceRecallProviderError) => {
        const isLast = index === chain.length - 1;
        const transport =
          error._tag === "SourceRecallUnreachableError" ||
          error._tag === "SourceRecallTimeoutError";
        if (!isLast && !explicit && transport) {
          return step(index + 1);
        }
        return onError(entry, error);
      }),
    );
  };
  return step(0);
}

/** Builds the concrete adapter for a provider entry. */
function buildAdapter(
  provider: SourceRecallProviderConfig,
  fetch: SourceRecallFetch,
  nowMs: () => number,
): SourceRecallProvider {
  const http = { baseUrl: provider.endpoint, fetch, timeoutMs: provider.timeoutMs };
  if (provider.kind === "aleutian") {
    return createAleutianAdapter({
      id: provider.id,
      http,
      transport: provider.transport ?? "http",
      ...(provider.projectRoot ? { projectRoot: provider.projectRoot } : {}),
      ...(provider.languages ? { languages: provider.languages } : {}),
    });
  }
  return createSourceRecallAdapter({ id: provider.id, http, nowMs });
}

function clampTopK(topK: number): number {
  if (!Number.isFinite(topK) || topK <= 0) {
    return DEFAULT_TOP_K;
  }
  return Math.min(Math.trunc(topK), MAX_RESULTS);
}

function unavailabilityDiag(
  explicitId: string | undefined,
  unknownId: boolean,
): SourceRecallDiagnostic {
  if (unknownId) {
    return { kind: "unconfigured", detail: `no enabled provider named "${explicitId}"` };
  }
  return { kind: "unconfigured", detail: "no source-recall provider is configured or enabled" };
}

function unavailableQuery(
  input: SourceRecallQueryInput,
  diagnostic: SourceRecallDiagnostic,
): SourceRecallResult {
  return {
    status: "unavailable",
    providerId: null,
    providerKind: null,
    query: input.query,
    repo: input.repo ?? null,
    results: [],
    freshness: null,
    latencyMs: null,
    capped: false,
    truncated: false,
    diagnostics: [diagnostic],
  };
}

/** Maps a typed provider error to a query result: a not-ready repo is `unready`, else `error`. */
function queryErrorResult(
  entry: Entry,
  input: SourceRecallQueryInput,
  error: SourceRecallProviderError,
): SourceRecallResult {
  const diagnostic = diagnosticOf(error);
  const status: SourceRecallResult["status"] =
    diagnostic.kind === "repo_not_ready" || diagnostic.kind === "not_initialized"
      ? "unready"
      : diagnostic.kind === "unreachable" || diagnostic.kind === "timeout"
        ? "unavailable"
        : "error";
  return {
    status,
    providerId: entry.config.id,
    providerKind: entry.config.kind,
    query: input.query,
    repo: input.repo ?? null,
    results: [],
    freshness: null,
    latencyMs: null,
    capped: false,
    truncated: false,
    diagnostics: [diagnostic],
  };
}

function refreshErrorResult(
  entry: Entry,
  repo: string | undefined,
  error: SourceRecallProviderError,
): SourceRecallRefreshResult {
  const diagnostic = diagnosticOf(error);
  const status: SourceRecallRefreshResult["status"] =
    diagnostic.kind === "rate_limited"
      ? "rate_limited"
      : diagnostic.kind === "repo_not_ready" || diagnostic.kind === "not_initialized"
        ? "unready"
        : diagnostic.kind === "unreachable" || diagnostic.kind === "timeout"
          ? "unavailable"
          : "error";
  return {
    status,
    providerId: entry.config.id,
    providerKind: entry.config.kind,
    repo: repo ?? entry.config.repo ?? null,
    filesUpdated: null,
    refreshMs: null,
    diagnostics: [diagnostic],
  };
}
