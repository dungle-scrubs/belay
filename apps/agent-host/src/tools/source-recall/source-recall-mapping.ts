/**
 * Responsible for: the PURE mapping between the `source-recall` FastAPI daemon's documented JSON
 * shapes (README + src/source_recall/server.py) and Trevor's normalized source-recall model. Kept
 * separate from request execution (M3 REFACTOR) so decoding/normalization is unit-tested without any
 * HTTP, and the adapter stays a thin transport + orchestration layer over these functions.
 *
 * Not for: making requests (that is the adapter over http.ts) or config parsing (config.ts).
 */
import type {
  SourceRecallFreshness,
  SourceRecallReadiness,
  SourceRecallRepoStatus,
  SourceRecallResultItem,
} from "@trevor/session";

/** `GET /health` body: `{ ok, repos, uptime_s }`. */
export interface SrHealthBody {
  readonly ok: boolean;
  readonly repos: readonly string[];
  readonly uptime_s: number;
}

/** One `GET /repos` entry. */
export interface SrRepoInfo {
  readonly name: string;
  readonly path: string;
  readonly file_count: number;
  readonly chunk_count: number;
  readonly vector_count: number;
}

/** `GET /repos` body. */
export interface SrReposBody {
  readonly repos: readonly SrRepoInfo[];
}

/** One `POST /query` result row. */
export interface SrQueryResult {
  readonly chunk_id: string;
  readonly file_path: string;
  readonly symbol_name: string;
  readonly symbol_type: string;
  readonly content: string;
  readonly score: number;
  readonly start_line: number;
  readonly end_line: number;
  readonly search_quality: string;
  readonly match_reason: string;
  readonly repo_name?: string | null;
}

/** `POST /query` body. */
export interface SrQueryBody {
  readonly results: readonly SrQueryResult[];
  readonly query_ms: number;
}

/** `GET /status` body. */
export interface SrStatusBody {
  readonly repo_path: string;
  readonly file_count: number;
  readonly chunk_count: number;
  readonly vector_count: number;
  readonly embed_model: string;
  readonly embed_dimensions: number;
  readonly db_size_bytes: number;
  readonly indexed_at: string;
}

/** `POST /refresh` body. */
export interface SrRefreshBody {
  readonly files_updated: number;
  readonly refresh_ms: number;
}

/** Milliseconds after which an index is treated as stale (the source-recall daemon auto-refreshes on
 *  query, so this is only a display hint - a day-old index is worth flagging). */
export const SR_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** True when the parsed body is a `results` envelope (defends against a truncated/foreign body). */
export function isQueryBody(body: unknown): body is SrQueryBody {
  return typeof body === "object" && body !== null && Array.isArray((body as SrQueryBody).results);
}

/** True when the parsed body is a `repos` envelope. */
export function isReposBody(body: unknown): body is SrReposBody {
  return typeof body === "object" && body !== null && Array.isArray((body as SrReposBody).repos);
}

/**
 * Normalizes one `source-recall` chunk into a {@link SourceRecallResultItem}, capping the snippet to
 * `maxSnippet` chars (full files are read through the normal read tools). Returns the item plus
 * whether its snippet was truncated, so the caller can set the result's `truncated` flag.
 */
export function toResultItem(
  providerId: string,
  row: SrQueryResult,
  repoFallback: string | null,
  maxSnippet: number,
): { readonly item: SourceRecallResultItem; readonly truncated: boolean } {
  const content = str(row.content);
  const truncated = content.length > maxSnippet;
  const snippet = truncated ? `${content.slice(0, maxSnippet)}…` : content;
  return {
    truncated,
    item: {
      providerId,
      filePath: str(row.file_path),
      startLine: num(row.start_line),
      endLine: num(row.end_line),
      symbolName: str(row.symbol_name),
      symbolType: str(row.symbol_type),
      snippet,
      score: num(row.score),
      matchReason: str(row.match_reason, "hybrid"),
      searchQuality: str(row.search_quality, "text_fallback"),
      repoName: str(row.repo_name) || repoFallback,
    },
  };
}

/** Builds freshness from a `GET /status` body: an ISO `indexed_at` older than the stale window flags stale. */
export function freshnessFromStatus(body: SrStatusBody, nowMs: number): SourceRecallFreshness {
  const indexedAt = str(body.indexed_at) || null;
  return {
    indexedAt,
    lastCommit: null,
    fileCount: num(body.file_count),
    chunkCount: num(body.chunk_count),
    vectorCount: num(body.vector_count),
    stale: isStale(indexedAt, nowMs),
  };
}

/** Builds a per-repo status row from a `GET /repos` entry (no timestamp there, so freshness is counts-only). */
export function repoStatusFromRepoInfo(info: SrRepoInfo): SourceRecallRepoStatus {
  const readiness: SourceRecallReadiness = info.chunk_count > 0 ? "ready" : "unready";
  return {
    name: str(info.name),
    readiness,
    freshness: {
      indexedAt: null,
      lastCommit: null,
      fileCount: num(info.file_count),
      chunkCount: num(info.chunk_count),
      vectorCount: num(info.vector_count),
      stale: false,
    },
  };
}

/** True when an ISO timestamp is older than {@link SR_STALE_AFTER_MS}; a missing/unparseable time is not stale. */
export function isStale(indexedAt: string | null, nowMs: number): boolean {
  if (!indexedAt) {
    return false;
  }
  const then = Date.parse(indexedAt);
  return Number.isFinite(then) && nowMs - then > SR_STALE_AFTER_MS;
}
