/**
 * The session-recall wire contract (D-044): the serializable shape the `session_recall` tool
 * returns as its result, shared by the host (which produces it) and the web (which renders it).
 * Like the rest of the protocol it lives in `@trevor/session` so the two surfaces can never
 * disagree on the payload. The engine-internal types (records, anchors, neighborhoods) stay in
 * the host; only the result that crosses the boundary is here.
 */

/** Where a recalled source came from: this session's folded-away detail, or a sibling session. */
export type RecallOrigin = "current-compacted" | "sibling-session";

/**
 * The kinds of conversational unit a recalled source can represent, as a runtime array so the host
 * tool can build its filter schema/validation from the same source the type is derived from (the
 * type and the runtime list cannot drift). Order is the canonical filter order.
 */
export const RECALL_KINDS = ["user", "assistant", "tool", "fold"] as const;

/** The kind of conversational unit a recalled source represents. */
export type RecallKind = (typeof RECALL_KINDS)[number];

/** Why a recall ended the way it did - the typed outcomes the result distinguishes. */
export type RecallStatus =
  | "ok" // at least one finding
  | "no_hits" // searched successfully, nothing matched
  | "partial" // searched, but some sessions were unreachable/stale/corrupt
  | "unavailable" // no recallable corpus at all (no fold yet, no siblings, inventory down)
  | "invalid_filters" // the supplied filters were malformed
  | "error"; // an internal failure

/** A per-session problem surfaced as a visible partial-search diagnostic (never silent absence). */
export interface RecallDiagnostic {
  readonly sessionId: string;
  readonly kind: "unreadable" | "empty" | "stale" | "corrupt" | "skipped";
  readonly detail: string;
}

/** One distilled finding the recall returns, with the source ids it cites. */
export interface RecallFinding {
  readonly summary: string;
  /** Stable `${sessionId}#${seq}` pointers into the cited sources. */
  readonly citations: readonly string[];
}

/** A source row surfaced in the transcript: a found record's provenance + excerpt. */
export interface RecallCitedSource {
  readonly id: string;
  readonly sessionId: string;
  readonly sessionLabel: string;
  readonly origin: RecallOrigin;
  readonly seq: number;
  readonly range: { readonly fromSeq: number; readonly toSeq: number };
  readonly kind: RecallKind;
  readonly timestamp: string;
  readonly excerpt: string;
}

/** The activity counts the transcript renders as a compact summary. */
export interface RecallActivity {
  readonly searchedSessions: number;
  readonly searchedFolds: number;
  readonly searchedRecords: number;
  readonly anchors: number;
  readonly neighborhoods: number;
}

/** The full recall result: model-facing findings plus the counts, sources, and diagnostics. */
export interface RecallResult {
  readonly status: RecallStatus;
  readonly query: string;
  readonly findings: readonly RecallFinding[];
  readonly sources: readonly RecallCitedSource[];
  readonly diagnostics: readonly RecallDiagnostic[];
  readonly activity: RecallActivity;
}

const STATUSES: ReadonlySet<string> = new Set<RecallStatus>([
  "ok",
  "no_hits",
  "partial",
  "unavailable",
  "invalid_filters",
  "error",
]);

/**
 * Defensively decodes a `session_recall` tool result string into a {@link RecallResult}. Returns
 * null while the call is still running (no result yet) or when the body is an `error:` line / not
 * a recall envelope, so the renderer can show the working/error states without trusting the shape.
 */
export function decodeRecallResult(raw: string | undefined): RecallResult | null {
  if (!raw || raw.startsWith("error:")) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RecallResult>;
    if (
      typeof parsed.status === "string" &&
      STATUSES.has(parsed.status) &&
      Array.isArray(parsed.findings)
    ) {
      return parsed as RecallResult;
    }
  } catch {
    // truncated or non-JSON; fall through
  }
  return null;
}
