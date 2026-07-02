import type { RecallKind, RecallOrigin } from "@trevor/session";

/**
 * Session recall (D-044) engine-internal types. Recall searches the current project's DURABLE
 * conversation corpus that is NOT already in the active prompt: the compacted-away detail of the
 * current session, plus other durable sessions for the same project/workspace. It is not a slash
 * command, not ambient memory, and not codebase search.
 *
 * The SERIALIZABLE result types (RecallResult, RecallFinding, RecallCitedSource, RecallDiagnostic,
 * RecallStatus, RecallOrigin, RecallKind) are the cross-surface wire contract and live in
 * `@trevor/session`; they are re-exported here so the engine reads one set of names. The types
 * below (records, anchors, neighborhoods, filters) never cross the boundary, so they stay local.
 *
 * Responsible for: the recall engine's internal record/anchor/neighborhood/filter types, plus
 * re-exports of the serializable wire-contract result types.
 */

export type {
  RecallActivity,
  RecallCitedSource,
  RecallDiagnostic,
  RecallFinding,
  RecallKind,
  RecallOrigin,
  RecallResult,
  RecallStatus,
} from "@trevor/session";

/** Stable provenance for the session a recall record originated in, used for citations. */
export interface RecallSessionRef {
  readonly sessionId: string;
  /** Human-facing label (the session's first user message / title), for citations + rows. */
  readonly label: string;
  /** Base-repo/project name (workspace basename) used to scope "same project". */
  readonly project: string | null;
  readonly origin: RecallOrigin;
}

/**
 * One searchable conversational unit: a user message, an assistant reply, a tool result, or a
 * compaction fold summary. Carries the stable source pointer (session + seq range + run +
 * timestamp) so a search hit can always be cited back to a precise place in the durable log.
 */
export interface RecallRecord {
  /** `${sessionId}#${seq}` - stable across runs, used for dedupe + neighborhood keys. */
  readonly id: string;
  readonly session: RecallSessionRef;
  /** The event seq this record anchors at (the neighborhood centre). */
  readonly seq: number;
  /** Folded turn range for a `fold` record; otherwise the single event's seq as a 1-wide range. */
  readonly range: { readonly fromSeq: number; readonly toSeq: number };
  readonly kind: RecallKind;
  /** Turn correlation id (runId) when known, else null - for the turn-range/run filter. */
  readonly runId: string | null;
  /** Tool name for a `tool` record (drives the tool-name filter), else null. */
  readonly tool: string | null;
  /** Fold id for a `fold` record (drives the folded-span filter), else null. */
  readonly foldId: string | null;
  readonly timestamp: string;
  /** Normalized searchable + display text (whitespace-collapsed, per-record capped). */
  readonly text: string;
}

/** Structured filters narrowing the corpus before ranking (all optional, all AND-combined). */
export interface RecallFilters {
  /** Restrict to these session ids (after project scoping). */
  readonly sessionIds?: readonly string[];
  /** Restrict to records anchored within [fromSeq, toSeq] (inclusive). */
  readonly turnRange?: { readonly fromSeq?: number; readonly toSeq?: number };
  /** Restrict to these record kinds. */
  readonly kinds?: readonly RecallKind[];
  /** Restrict to `tool` records produced by this tool. */
  readonly tool?: string;
  /** Restrict to records inside this compaction fold's span. */
  readonly foldId?: string;
}

/** A ranked search hit: the matched record plus its score and a short excerpt. */
export interface RecallAnchor {
  readonly record: RecallRecord;
  readonly score: number;
  /** A short, query-centred excerpt of the record text. */
  readonly excerpt: string;
}

/** A search anchor expanded into the surrounding turns/events from the same session. */
export interface RecallNeighborhood {
  readonly anchor: RecallAnchor;
  /** The anchor plus its bounded context window, in seq order. */
  readonly records: readonly RecallRecord[];
}
