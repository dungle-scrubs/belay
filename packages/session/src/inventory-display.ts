import type { SessionSummary } from "./inventory";

/**
 * The non-archived sessions (D-094): the default view for the sidebar, resume chooser, and
 * current-project navigation. Archived sessions remain in the durable store but are filtered out
 * here unless a caller explicitly wants them (e.g. an archive browser or `trevor list --archived`).
 */
export function activeSessions(summaries: readonly SessionSummary[]): SessionSummary[] {
  return summaries.filter((s) => !s.archived && !s.deleted);
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
