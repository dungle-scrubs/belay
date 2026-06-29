/**
 * The docs result envelope: the structured, model-facing JSON the docs tool returns. It mirrors
 * web_fetch's "one form the model reads and the web renders" shape - a flat envelope with an
 * `outcome` discriminator, a human-readable `detail`, and optional typed payloads attached only when
 * an outcome carries one. Absent optional fields are omitted so the wire form stays lean. Every
 * action resolves to one of the typed outcomes here, including `unavailable` (a dependency is
 * missing) and `not-implemented` (a later phase owns that action), so no docs call throws the turn.
 */

import type { CorpusListing, CorpusSummary, PageView, QueryExcerpt, QueryResult } from "./corpus";

function withDiagnostics(diagnostics: readonly string[] | undefined): {
  diagnostics?: readonly string[];
} {
  return diagnostics && diagnostics.length > 0 ? { diagnostics } : {};
}

/**
 * The result-size cap + continuation metadata every query action returns: how much was returned of
 * the total, whether the cap clipped it, and the `nextOffset` cursor to pass back to continue. The
 * shared shape is what keeps a large corpus from dumping wholesale into the prompt.
 */
export interface ResultWindow {
  /** What the counts measure: ranked excerpts, page characters, or corpora. */
  readonly unit: "excerpts" | "chars" | "corpora";
  readonly returned: number;
  readonly total: number;
  /** True when the cap clipped the output and `nextOffset` continues it. */
  readonly truncated: boolean;
  readonly nextOffset?: number;
}

/** The actions the docs tool exposes. */
export const DOCS_ACTIONS = ["resolve", "refresh", "search", "read", "list", "status"] as const;

export type DocsAction = (typeof DOCS_ACTIONS)[number];

/**
 * How a docs action resolved. `unavailable` and `not-implemented` are the two outcomes wired now;
 * the rest reserve their slot so later phases attach payloads without a shape change.
 */
export const DOCS_OUTCOMES = [
  "ok",
  "unavailable",
  "not-implemented",
  "not-found",
  "corrupt",
  "error",
] as const;

export type DocsOutcome = (typeof DOCS_OUTCOMES)[number];

export interface DocsResult {
  readonly action: DocsAction;
  readonly outcome: DocsOutcome;
  readonly detail: string;
  /** On `unavailable`: the dependencies that were missing. */
  readonly missing?: readonly string[];
  /** On resolve/refresh/search/status: the target corpus. */
  readonly corpus?: CorpusSummary;
  /** On list: the known corpora with their per-entry freshness. */
  readonly corpora?: readonly CorpusListing[];
  /** On search: the ranked, cited excerpts. */
  readonly query?: QueryResult;
  /** On resolve/refresh: a bounded set of selected cited excerpts (the corpus preview). */
  readonly excerpts?: readonly QueryExcerpt[];
  /** On read: the bounded page view. */
  readonly page?: PageView;
  /** On status: the corpus's provenance line. */
  readonly provenance?: string;
  /** On resolve/refresh/search/read/status: whether the served content is stale (never omitted when
   *  stale, so stale content is never presented as fresh). */
  readonly stale?: boolean;
  /** The result-size cap + continuation metadata for the action's primary payload. */
  readonly window?: ResultWindow;
  /** Partial/corrupt notes a load surfaced. */
  readonly diagnostics?: readonly string[];
}

/** The typed outcome for a docs action whose required dependencies are not ready. */
export function unavailableResult(action: DocsAction, missing: readonly string[]): DocsResult {
  return {
    action,
    outcome: "unavailable",
    detail: `docs ${action} is unavailable: missing ${missing.join(", ")}`,
    missing,
  };
}

/** The typed outcome for a docs action whose implementing phase is not built yet. */
export function notImplementedResult(action: DocsAction): DocsResult {
  return {
    action,
    outcome: "not-implemented",
    detail: `docs ${action} is not implemented yet`,
  };
}

/** A typed failure that is neither a missing dependency nor an unbuilt phase. */
export function errorResult(
  action: DocsAction,
  detail: string,
  diagnostics?: readonly string[],
): DocsResult {
  return { action, outcome: "error", detail, ...withDiagnostics(diagnostics) };
}

/** A targeted corpus that exists on disk but could not be read. */
export function corruptResult(
  action: DocsAction,
  detail: string,
  diagnostics?: readonly string[],
): DocsResult {
  return { action, outcome: "corrupt", detail, ...withDiagnostics(diagnostics) };
}

/** Serializes an envelope to the compact JSON the model reads, omitting absent optional fields. */
export function serializeDocsResult(result: DocsResult): string {
  return JSON.stringify({
    action: result.action,
    outcome: result.outcome,
    detail: result.detail,
    ...(result.missing !== undefined ? { missing: result.missing } : {}),
    ...(result.corpus !== undefined ? { corpus: result.corpus } : {}),
    ...(result.corpora !== undefined ? { corpora: result.corpora } : {}),
    ...(result.query !== undefined ? { query: result.query } : {}),
    ...(result.excerpts !== undefined ? { excerpts: result.excerpts } : {}),
    ...(result.page !== undefined ? { page: result.page } : {}),
    ...(result.provenance !== undefined ? { provenance: result.provenance } : {}),
    ...(result.stale !== undefined ? { stale: result.stale } : {}),
    ...(result.window !== undefined ? { window: result.window } : {}),
    ...(result.diagnostics !== undefined ? { diagnostics: result.diagnostics } : {}),
  });
}
