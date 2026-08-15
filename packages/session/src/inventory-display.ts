import type { SessionSummary } from "./inventory";

/**
 * The canonical most-recent-activity-first comparator (updatedAt descending). The one recency ordering
 * the sidebar, resume chooser, tangent list, and recall siblings all sort by, so "newest first" can't
 * drift between them. Pure; ISO timestamps sort lexicographically.
 */
export function byRecency(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * The non-archived sessions (D-094): the default view for the sidebar, resume chooser, and
 * current-project navigation. Archived sessions remain in the durable store but are filtered out
 * here unless a caller explicitly wants them (e.g. an archive browser or `belay list --archived`).
 * Tangents (plan 37) are also excluded: they are scoped side threads reached from their PARENT
 * session (see {@link tangentsOf}), never surfaced in ordinary top-level navigation.
 */
export function activeSessions(summaries: readonly SessionSummary[]): SessionSummary[] {
  return summaries.filter((s) => !s.archived && !s.deleted && !s.tangentOf);
}

/**
 * The project-scoped session selection (C-01): the active (or, with `archived`, the archived) sessions
 * for `project`, newest activity first. The ONE owner of "what shows in a project's navigation" - both
 * the web sidebar and the SDK's `selectSessions` delegate here, so the scope rule lives once. Because
 * the active view runs through {@link activeSessions}, tangents are excluded by construction (they
 * surface only from their parent), closing the leak a hand-rolled `!archived && !deleted` filter opens.
 * A null/absent `project` lists across every project. Pure; never mutates the input.
 */
export function sessionsForProject(
  summaries: readonly SessionSummary[],
  project: string | null | undefined,
  opts: { readonly archived?: boolean } = {},
): SessionSummary[] {
  const scope = opts.archived ? archivedSessions(summaries) : activeSessions(summaries);
  const inProject = project != null ? scope.filter((s) => s.project === project) : scope;
  return [...inProject].sort(byRecency);
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
    .sort(byRecency);
}

/** The archived (not deleted) sessions only (for an explicit archive filter / `belay list --archived`). */
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
  const current = summaries.filter((s) => currentProject != null && s.project === currentProject);
  const others = summaries.filter((s) => currentProject == null || s.project !== currentProject);
  return [...current.sort(byRecency), ...others.sort(byRecency)];
}
