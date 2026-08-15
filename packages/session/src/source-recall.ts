/**
 * The indexed source-recall wire contract (plan 38): the serializable shapes the
 * `source_recall`, `source_index_status`, and `source_index_refresh` tools return, shared by the
 * host (which produces them from a provider adapter) and the web (which renders them). Like the
 * rest of the protocol it lives in `@belay/session` so the two surfaces can never disagree on the
 * payload. The provider-adapter interface, HTTP clients, and mapping stay in the host; only the
 * normalized result that crosses the boundary is here.
 *
 * Indexed source recall is NOT session recall. Session recall (`recall.ts`) searches this project's
 * DURABLE CONVERSATION corpus - compacted-away and sibling-session history. Indexed source recall
 * searches SOURCE FILES, symbols, chunks, and graph relationships over a prebuilt code index. The
 * two contracts are deliberately disjoint (different discriminant keys), and a test proves neither
 * result decodes as the other, so the names can never blur back together (D-001).
 *
 * Responsible for: the source-recall wire result/status/capability vocabulary and the defensive
 * decoders the renderer trusts.
 * Not for: the provider interface / HTTP adapters / mapping - those are host-internal.
 */

/**
 * The concrete indexed-source backends Belay speaks to. `source-recall` is the local Python/FastAPI
 * hybrid BM25+vector chunk daemon (the first concrete adapter); `aleutian` is Aleutian Trace's
 * structural graph/context/symbol intelligence. Both implement one provider contract; other backends
 * can be added by widening this union and adding an adapter.
 */
export const SOURCE_RECALL_PROVIDER_KINDS = ["source-recall", "aleutian"] as const;

/** The kind of indexed-source backend a provider entry adapts. */
export type SourceRecallProviderKind = (typeof SOURCE_RECALL_PROVIDER_KINDS)[number];

/**
 * The normalized capabilities a provider can advertise after discovery. Belay's tools depend on
 * these capabilities, never on a backend's raw endpoint set (D-002/D-003): `source-recall` typically
 * offers chunk/semantic search + refresh + status; Aleutian offers symbol/graph/context and, where
 * Weaviate is up, semantic search. Order is the canonical discovery/display order.
 */
export const SOURCE_RECALL_CAPABILITIES = [
  "chunk_search", // hybrid BM25/vector code+document chunk retrieval
  "symbol_search", // symbol lookup by name/kind
  "call_graph", // callers/callees/call-chain/references
  "context_assembly", // assembled LLM context for a task/query
  "semantic_index", // vector semantic search over indexed symbols/chunks
  "refresh", // incremental re-index
  "status", // index metrics / readiness
] as const;

/** One normalized provider capability. */
export type SourceRecallCapability = (typeof SOURCE_RECALL_CAPABILITIES)[number];

/**
 * How ready a provider / repo index is. `unconfigured` means no provider entry at all; `unreachable`
 * means a configured backend did not answer; the rest describe a reachable backend's index state.
 */
export type SourceRecallReadiness =
  | "ready"
  | "unready"
  | "indexing"
  | "unreachable"
  | "unconfigured";

/** Why a source-recall query ended the way it did - the typed outcomes the result distinguishes. */
export type SourceRecallStatus =
  | "ok" // at least one retrieved candidate
  | "no_results" // queried successfully, nothing matched
  | "stale" // returned results, but the index is stale (freshness.stale)
  | "unready" // the repo/index is not ready to answer
  | "unavailable" // no configured/enabled/reachable provider at all
  | "invalid_request" // the query/repo/provider arguments were malformed
  | "error"; // an internal/adapter failure

/**
 * A structured, visible diagnostic (never a silent absence, never a raw daemon internal). Each maps
 * a failure class - unreachable backend, timeout, missing repo, malformed response - to a bounded
 * human-readable detail. Secrets/keys/URLs never reach `detail`.
 */
export interface SourceRecallDiagnostic {
  readonly kind:
    | "unconfigured"
    | "disabled"
    | "unreachable"
    | "timeout"
    | "repo_not_found"
    | "repo_not_ready"
    | "no_repos_ready"
    | "malformed_response"
    | "rate_limited"
    | "not_initialized"
    | "internal";
  readonly detail: string;
}

/** Freshness metadata for the queried index, surfaced so stale/empty indexes are never misleading. */
export interface SourceRecallFreshness {
  readonly indexedAt: string | null;
  readonly lastCommit: string | null;
  readonly fileCount: number | null;
  readonly chunkCount: number | null;
  readonly vectorCount: number | null;
  readonly stale: boolean;
}

/**
 * One retrieved candidate with a precise file/line citation. The snippet is bounded; the model reads
 * full files through the normal read tools. `meta` carries optional provider-specific detail
 * (signature, package, caller/callee names, token budget) for detail views - shape-only, never
 * secrets or raw daemon payloads.
 */
export interface SourceRecallResultItem {
  readonly providerId: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbolName: string;
  readonly symbolType: string;
  readonly snippet: string;
  readonly score: number;
  readonly matchReason: string;
  /** Parse/retrieval fidelity: ast/regex/text_fallback (source-recall) or graph/semantic (Aleutian). */
  readonly searchQuality: string;
  readonly repoName: string | null;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}

/** The full `source_recall` query result: cited candidates plus freshness, latency, and caps. */
export interface SourceRecallResult {
  readonly status: SourceRecallStatus;
  readonly providerId: string | null;
  readonly providerKind: SourceRecallProviderKind | null;
  readonly query: string;
  readonly repo: string | null;
  readonly results: readonly SourceRecallResultItem[];
  readonly freshness: SourceRecallFreshness | null;
  readonly latencyMs: number | null;
  /** True when the result count hit the tool's hard cap (more candidates existed). */
  readonly capped: boolean;
  /** True when at least one snippet was truncated to its per-item bound. */
  readonly truncated: boolean;
  readonly diagnostics: readonly SourceRecallDiagnostic[];
}

/** One repo's readiness + freshness in a `source_index_status` result. */
export interface SourceRecallRepoStatus {
  readonly name: string;
  readonly readiness: SourceRecallReadiness;
  readonly freshness: SourceRecallFreshness;
}

/** The `source_index_status` result: which repos a provider serves and how ready/fresh each is. */
export interface SourceRecallIndexStatus {
  readonly status: "ok" | "unavailable" | "unready" | "error";
  readonly providerId: string | null;
  readonly providerKind: SourceRecallProviderKind | null;
  readonly capabilities: readonly SourceRecallCapability[];
  readonly repos: readonly SourceRecallRepoStatus[];
  readonly diagnostics: readonly SourceRecallDiagnostic[];
}

/** The `source_index_refresh` result: how a requested incremental re-index went. */
export interface SourceRecallRefreshResult {
  readonly status: "ok" | "unavailable" | "rate_limited" | "unready" | "error";
  readonly providerId: string | null;
  readonly providerKind: SourceRecallProviderKind | null;
  readonly repo: string | null;
  readonly filesUpdated: number | null;
  readonly refreshMs: number | null;
  readonly diagnostics: readonly SourceRecallDiagnostic[];
}

const QUERY_STATUSES: ReadonlySet<string> = new Set<SourceRecallStatus>([
  "ok",
  "no_results",
  "stale",
  "unready",
  "unavailable",
  "invalid_request",
  "error",
]);

const STATUS_STATUSES: ReadonlySet<string> = new Set<SourceRecallIndexStatus["status"]>([
  "ok",
  "unavailable",
  "unready",
  "error",
]);

const REFRESH_STATUSES: ReadonlySet<string> = new Set<SourceRecallRefreshResult["status"]>([
  "ok",
  "unavailable",
  "rate_limited",
  "unready",
  "error",
]);

/**
 * Defensively decodes a `source_recall` tool result string into a {@link SourceRecallResult}. Returns
 * null while the call is still running (no result yet), when the body is an `error:` line, or when the
 * shape is not a source-recall query envelope. The `results` array + query-status discriminants are
 * what make this reject a session-recall {@link import("./recall").RecallResult} (which carries
 * `findings`, never `results`) - the two contracts cannot be interchanged (D-001).
 */
export function decodeSourceRecallResult(raw: string | undefined): SourceRecallResult | null {
  const parsed = parseEnvelope(raw);
  if (
    parsed &&
    typeof parsed.status === "string" &&
    QUERY_STATUSES.has(parsed.status) &&
    Array.isArray((parsed as { results?: unknown }).results)
  ) {
    return parsed as unknown as SourceRecallResult;
  }
  return null;
}

/** Defensively decodes a `source_index_status` tool result string, or null when the shape is wrong. */
export function decodeSourceRecallIndexStatus(
  raw: string | undefined,
): SourceRecallIndexStatus | null {
  const parsed = parseEnvelope(raw);
  if (
    parsed &&
    typeof parsed.status === "string" &&
    STATUS_STATUSES.has(parsed.status) &&
    Array.isArray((parsed as { repos?: unknown }).repos)
  ) {
    return parsed as unknown as SourceRecallIndexStatus;
  }
  return null;
}

/** Defensively decodes a `source_index_refresh` tool result string, or null when the shape is wrong. */
export function decodeSourceRecallRefreshResult(
  raw: string | undefined,
): SourceRecallRefreshResult | null {
  const parsed = parseEnvelope(raw);
  if (
    parsed &&
    typeof parsed.status === "string" &&
    REFRESH_STATUSES.has(parsed.status) &&
    "filesUpdated" in parsed &&
    !("results" in parsed) &&
    !("repos" in parsed)
  ) {
    return parsed as unknown as SourceRecallRefreshResult;
  }
  return null;
}

/** Parses a tool-result string into a record, or null for running/error/non-JSON bodies. */
function parseEnvelope(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || raw.startsWith("error:")) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
