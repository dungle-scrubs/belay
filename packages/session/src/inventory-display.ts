import type { SessionSummary } from "./inventory";

/**
 * The non-archived sessions (D-094): the default view for the sidebar, resume chooser, and
 * current-project navigation. Archived sessions remain in the durable store but are filtered out
 * here unless a caller explicitly wants them (e.g. an archive browser or `trevor list --archived`).
 * Tangents (plan 37) are also excluded: they are scoped side threads reached from their PARENT
 * session (see {@link tangentsOf}), never surfaced in ordinary top-level navigation.
 */
export function activeSessions(summaries: readonly SessionSummary[]): SessionSummary[] {
  return summaries.filter((s) => !s.archived && !s.deleted && !s.tangentOf);
}

/**
 * The tangents (plan 37) branched from `parentSessionId`, most-recent activity first. A filtered
 * read-model - the counterpart to resume filtering - so a parent session can discover ITS OWN
 * tangents without them cluttering the global session list. Soft-deleted tangents are excluded; an
 * archived-or-missing parent is the caller's concern (the rows still resolve for navigation). Pure.
 */
export function tangentsOf(
  summaries: readonly SessionSummary[],
  parentSessionId: string,
): SessionSummary[] {
  return summaries
    .filter((s) => !s.deleted && s.tangentOf?.parentSessionId === parentSessionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The archived (not deleted) sessions only (for an explicit archive filter / `trevor list --archived`). */
export function archivedSessions(summaries: readonly SessionSummary[]): SessionSummary[] {
  return summaries.filter((s) => s.archived && !s.deleted);
}

/**
 * Orders summaries for the resume chooser: the current project's sessions first, then the
 * rest, each block by most-recent activity (updatedAt) descending. Stable + pure - takes
 * the current project name (the active session's base repo) so the browser owns the
 * "current project" notion the store can't know. Never mutates the input.
 */
export function sortInventory(
  summaries: readonly SessionSummary[],
  currentProject: string | null,
): SessionSummary[] {
  const byRecency = (a: SessionSummary, b: SessionSummary) =>
    b.updatedAt.localeCompare(a.updatedAt);
  const current = summaries.filter((s) => currentProject != null && s.project === currentProject);
  const others = summaries.filter((s) => currentProject == null || s.project !== currentProject);
  return [...current.sort(byRecency), ...others.sort(byRecency)];
}
