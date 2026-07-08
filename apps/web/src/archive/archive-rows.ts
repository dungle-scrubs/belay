import {
  archivedSessions,
  permanentDeleteEligibility,
  type SessionSummary,
  sortInventory,
} from "@trevor/session";

/**
 * The archive-browser read model (plan 04): a pure projection of the session inventory into the rows
 * the archive-browser surface renders. It derives ONLY from `archivedSessions` (archived and not
 * soft-deleted) - a projection deliberately separate from the sidebar/resume rows (`resume-rows.ts`),
 * which exclude archived sessions. Each row carries the management metadata the surface shows plus a
 * permanent-delete eligibility (`protectedReason`): a live host or an active turn protects an archived
 * session from a destructive purge, so a row's delete affordance can be disabled with a clear reason.
 */

export interface ArchivedSessionRow {
  readonly sessionId: string;
  /** First user message (truncated) or the session id - the row's primary label. */
  readonly title: string;
  /** Base-repo name, for grouping/context; null when unknown. */
  readonly project: string | null;
  /**
   * The canonical absolute project path (plan 58 M7): drives project-path filtering in the archive
   * browser and the shared project label. Null when the session has no project binding.
   */
  readonly projectPath: string | null;
  readonly cwd: string | null;
  /** Last activity timestamp (updatedAt), for the recency label. */
  readonly updatedAt: string;
  readonly eventCount: number;
  /**
   * Why permanent delete is blocked for this row, or null when it is eligible. A LIVE host or an active
   * (running/queued) turn protects the session from a purge - the read-model form of the M4 rejection.
   */
  readonly protectedReason: string | null;
}

/** Why an archived session is protected from permanent delete, or null when it is eligible. Defers to the
 *  shared {@link permanentDeleteEligibility} so the row's affordance and the store's gate never disagree
 *  (for an archived row the only non-ok verdict is `protected`). */
export function archiveProtectedReason(summary: SessionSummary): string | null {
  const verdict = permanentDeleteEligibility(summary);
  return verdict.ok || verdict.reason !== "protected" ? null : verdict.detail;
}

/** Projects one archived summary into an archive-browser row. */
export function toArchiveRow(summary: SessionSummary): ArchivedSessionRow {
  return {
    sessionId: summary.sessionId,
    title: summary.title,
    project: summary.project,
    projectPath: summary.projectPath,
    cwd: summary.cwd,
    updatedAt: summary.updatedAt,
    eventCount: summary.eventCount,
    protectedReason: archiveProtectedReason(summary),
  };
}

/**
 * The archive-browser rows: the archived (not soft-deleted) sessions, newest activity first. Global -
 * unlike the resume rows it is NOT scoped to the current project, since the archive browser manages all
 * archived sessions.
 */
export function buildArchiveRows(summaries: readonly SessionSummary[]): ArchivedSessionRow[] {
  // `sortInventory(_, null)` is a pure most-recent-first sort (no current-project block), the same
  // recency order the sidebar/resume use - reused here so "newest activity first" lives in one place.
  return sortInventory(archivedSessions(summaries), null).map(toArchiveRow);
}

/** Whether a row may be permanently deleted (no protecting host/turn). */
export function isArchiveRowDeletable(row: ArchivedSessionRow): boolean {
  return row.protectedReason === null;
}
