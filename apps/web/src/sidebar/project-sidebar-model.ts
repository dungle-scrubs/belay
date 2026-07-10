import type { SessionSummary, WorktreeSummary } from "@trevor/session";
import { sessionProjectPath } from "../session/session-root";

/**
 * The project sidebar read model (plan 58 M5 + plan 58.2 + plan 58.7): a pure grouping of active
 * sessions under projects, built from registry records + the session inventory. Worktree badges
 * attach from the DURABLE `session.worktree` marker on each summary (so they survive a view switch),
 * enriched with live git state from the viewed host's `WorktreeSummary[]` snapshot when available.
 *
 * Grouping keys on the durable project path already folded into `SessionSummary.projectPath`
 * (offline-safe). Badge presence keys on the durable `SessionSummary.worktree` marker (plan 58.7);
 * live git state (dirty/ahead/behind) keys ONLY on `WorktreeSummary.sessionId` from the supplied
 * snapshot - never on paths.
 *
 * Pure over injected inputs; no React. A `ProjectGroup` is the unit the sidebar renders: a project
 * row with expand/collapse state plus session rows nested under it.
 */

/**
 * The project-metadata input the read model consumes. Structurally compatible with the launcher's
 * `ProjectRegistryRecord` (plan 58 M1) so a registry snapshot can be passed straight through, but
 * declared HERE so the web bundle never imports the node-side `@trevor/launcher` package. The
 * sidebar only needs the metadata fields, never the persistence operations.
 */
export interface ProjectSidebarRecord {
  /** Canonical absolute path - the registry key (the group key). */
  readonly path: string;
  /** User-friendly absolute or home-shortened path, for disambiguation. */
  readonly displayPath: string;
  /** Defaults to basename; user-renamable. */
  readonly displayName: string;
  /** Whether the project is collapsed in the sidebar (persisted). */
  readonly collapsed: boolean;
  /** ISO timestamp of first registration. */
  readonly createdAt: string;
  /** ISO timestamp of last modification. */
  readonly updatedAt: string;
  /** True when the supervisor reports the project folder gone from disk (plan 58.8). The record
   *  stays listed (sessions remain readable/archivable); only launching into it is blocked. */
  readonly missing?: boolean;
}

/**
 * One session row in a project group (plan 58.2): the inventory summary plus an optional attached
 * worktree summary for badge/tooltip rendering. `worktree` is set when EITHER the session carries a
 * durable `session.worktree` marker (plan 58.7 - badges even when the worktree's host is not the
 * viewed session) OR the viewed host's snapshot includes it for live git-state enrichment.
 */
export interface ProjectSessionRow {
  readonly summary: SessionSummary;
  readonly worktree: WorktreeSummary | null;
}

/** One project row in the sidebar, with its grouped sessions. */
export interface ProjectGroup {
  /** Canonical project path (or the transient key - the resolved session path). */
  readonly key: string;
  /** Project display name, or the path basename for a transient project. */
  readonly displayName: string;
  /** Full path for disambiguation (always carried, even when the name is unique). */
  readonly displayPath: string;
  /** Persisted collapsed state (overridden to false on a search-matched group). */
  readonly collapsed: boolean;
  /** True when no registry record exists but the project has active sessions. */
  readonly isTransient: boolean;
  /** Active sessions under this project, newest creation first, with optional worktree join. */
  readonly sessions: readonly ProjectSessionRow[];
  /** Count of active sessions (== sessions.length; named for the UI's count badge). */
  readonly activeCount: number;
  /** The max of the registry updatedAt and the project's session updatedAt values. */
  readonly updatedAt: string;
  /** ISO timestamp of first registration (creation order). */
  readonly createdAt: string;
  /** True when the project folder no longer exists on disk (plan 58.8): the row renders a red
   *  label + dead-path tooltip and New-session is blocked; everything else stays available. */
  readonly missing: boolean;
}

/**
 * Builds the sessionId -> non-baseline WorktreeSummary map used for badge attachment (plan 58.2).
 * Baseline rows are excluded so the main checkout session is never badged as a worktree. Paths are
 * never joined on: only the durable `sessionId` identity is a valid key. The map is current-host
 * scoped - callers must pass the viewed host's worktree snapshot, not an all-project catalog.
 */
export function buildWorktreeSessionMap(
  worktrees: readonly WorktreeSummary[] | undefined,
): ReadonlyMap<string, WorktreeSummary> {
  const map = new Map<string, WorktreeSummary>();
  if (!worktrees) {
    return map;
  }
  for (const wt of worktrees) {
    if (wt.baseline) {
      continue;
    }
    map.set(wt.sessionId, wt);
  }
  return map;
}

/**
 * Synthesizes a minimal identity-only {@link WorktreeSummary} from a session's durable worktree
 * marker (plan 58.7), so the badge renders even when the worktree's own host is NOT the viewed
 * session (no live snapshot to enrich from). Git state defaults to clean/zero since only the host
 * can read it; the live snapshot from `buildWorktreeSessionMap` overrides this when available.
 * Returns null when the session has no durable worktree marker (a baseline or plain session).
 */
export function worktreeSummaryFromIdentity(summary: SessionSummary): WorktreeSummary | null {
  if (!summary.worktree) {
    return null;
  }
  return {
    id: summary.worktree.id,
    baseRepo: summary.projectPath ?? summary.workspace ?? summary.cwd ?? "",
    baseRepoName: summary.project ?? "",
    branch: summary.worktree.branch,
    path: summary.worktree.path,
    sessionId: summary.sessionId,
    dirty: false,
    ahead: 0,
    behind: 0,
    conflict: false,
    detached: false,
    current: false,
    baseline: false,
    missing: false,
  };
}

/** The default number of sessions shown per project before a "Show more" affordance (M6). */
export const SESSION_CAP = 5;

export { sessionProjectPath };

/** The last path segment of a canonical path (the project's default display name). Browser-safe: no
 *  `node:path` (the web bundle stays free of node-only modules); mirrors `workspaceBasename`. */
function pathBasename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Canonicalizes a project path so `~` and its absolute expansion (`/Users/<name>`) don't appear as
 *  duplicate projects. The browser can't call `os.homedir()`, so it expands a leading `~` to the
 *  best-known home prefix from the OTHER paths it sees: if any session or registry record has an
 *  absolute `/Users/<seg>` path, that prefix replaces `~`. Falls back to leaving `~` as-is when no
 *  absolute sibling is available (so a lone `~/foo` still renders, just un-expanded). Pure. */
function canonicalizePath(rawPath: string, allPaths: readonly string[]): string {
  if (!rawPath.startsWith("~")) {
    return rawPath;
  }
  // Find an absolute path that looks like a home dir (`/Users/<name>/...`).
  const homePrefix = allPaths
    .filter((p) => p.startsWith("/Users/"))
    .map((p) => p.split("/").slice(0, 3).join("/"))
    .find((prefix, i, arr) => prefix && arr.indexOf(prefix) === i);
  if (!homePrefix) {
    return rawPath;
  }
  return rawPath.replace(/^~/, homePrefix);
}

/**
 * Builds the project sidebar read model: groups active (non-archived, non-deleted, non-tangent)
 * sessions under their project by resolved project path, merging known registry records with
 * transient projects (sessions whose path has no registry record).
 *
 * Ordering: creation order (oldest first), by the registry record's `createdAt`, so projects stay
 * put and do not re-order on activity. Transient projects (sessions with no registry record) sort
 * after known ones. Sessions within a project are sorted by `createdAt` descending (newest first)
 * so a live sibling emitting events never moves them.
 */
export function buildProjectSidebar(
  projects: readonly ProjectSidebarRecord[],
  sessions: readonly SessionSummary[],
  /**
   * Optional current-host worktree snapshot (plan 58.2). When supplied, non-baseline entries ENRICH
   * matching session rows with live git state (dirty/ahead/behind). Badge PRESENCE no longer depends
   * on this snapshot - it comes from the durable `session.worktree` marker on each summary (plan
   * 58.7), so a session stays badged even when its host is not the viewed session.
   */
  worktrees?: readonly WorktreeSummary[],
): readonly ProjectGroup[] {
  // Active sessions only: archived, deleted, AND tangents are excluded. Tangents surface only from
  // their parent session, never in ordinary top-level navigation (see activeSessions).
  const active = sessions.filter((s) => !s.archived && !s.deleted && !s.tangentOf);
  const worktreeBySession = buildWorktreeSessionMap(worktrees);

  // Collect all raw paths (from registry records + sessions) so canonicalization can infer the home
  // prefix from absolute siblings (e.g. resolve `~` to `/Users/<name>` when both are present).
  const allRawPaths = [
    ...projects.map((p) => p.path),
    ...active.map((s) => sessionProjectPath(s) ?? ""),
  ];

  // Index registry records by canonical path.
  const byPath = new Map<string, ProjectSidebarRecord>();
  for (const record of projects) {
    byPath.set(canonicalizePath(record.path, allRawPaths), record);
  }

  // Group active sessions by resolved project path. A null path (ungrouped) is skipped: a session
  // with no project binding does not surface its own project row. Join worktrees by sessionId only.
  const sessionsByPath = new Map<string, ProjectSessionRow[]>();
  for (const summary of active) {
    const path = sessionProjectPath(summary);
    if (path == null) {
      continue;
    }
    const canon = canonicalizePath(path, allRawPaths);
    // The badge: the durable session.worktree marker (plan 58.7) makes a row a worktree regardless
    // of which session is viewed. The viewed host's live WorktreeSummary snapshot enriches it with
    // git state (dirty/ahead/behind/conflict) when available; otherwise a minimal identity-only
    // summary is synthesized from the marker so the badge + tooltip still render. This is what keeps
    // the badge from vanishing when you switch away from the worktree session.
    const live = worktreeBySession.get(summary.sessionId);
    const row: ProjectSessionRow = {
      summary,
      worktree: live ?? worktreeSummaryFromIdentity(summary),
    };
    const list = sessionsByPath.get(canon);
    if (list) {
      list.push(row);
    } else {
      sessionsByPath.set(canon, [row]);
    }
  }

  // Merge known registry records with transient paths (sessions present but no record).
  const keys = new Set<string>([...byPath.keys(), ...sessionsByPath.keys()]);

  const groups: ProjectGroup[] = [];
  for (const key of keys) {
    const record = byPath.get(key);
    // Sessions are ordered by CREATION time (newest first), not by activity (updatedAt). Activity
    // ordering churned once concurrent worktree sessions (plan 58.7) put two live hosts in one
    // project: each host.online re-announcement / streaming delta bumped its session's updatedAt,
    // making the two rows leapfrog on every render. Creation order is stable - a sibling emitting
    // an event never moves another session. A sessionId tiebreaker keeps equal-createdAt sessions
    // from swapping between renders.
    const projectSessions = (sessionsByPath.get(key) ?? []).sort((a, b) => {
      const byCreation = b.summary.createdAt.localeCompare(a.summary.createdAt);
      return byCreation === 0 ? a.summary.sessionId.localeCompare(b.summary.sessionId) : byCreation;
    });

    // The aggregate updatedAt: the max of the registry record and all the project's sessions.
    const candidates = [
      record?.updatedAt ?? "",
      ...projectSessions.map((s) => s.summary.updatedAt),
    ];
    const updatedAt = candidates.reduce((max, v) => (v > max ? v : max), "");

    const isTransient = record == null;
    const displayName = record?.displayName ?? pathBasename(key);
    // Use the canonical key for display so the path matches what the user sees elsewhere (no `~`
    // when the absolute form is known).
    const displayPath = key;
    const collapsed = record?.collapsed ?? false;
    const createdAt = record?.createdAt ?? projectSessions[0]?.summary.createdAt ?? updatedAt;

    groups.push({
      key,
      displayName,
      displayPath,
      collapsed,
      isTransient,
      sessions: projectSessions,
      activeCount: projectSessions.length,
      updatedAt,
      createdAt,
      // Only a registry record can be marked missing (the supervisor stats registry paths); a
      // transient project has no record to mark and reads as present.
      missing: record?.missing ?? false,
    });
  }

  // Creation order (oldest first) by the registry record's createdAt, so projects stay put and do
  // NOT re-order on their own when a session resumes or activity changes. Transient projects (no
  // registry record) sort after known ones; a stable tiebreaker on the key keeps projects that share
  // a createdAt from swapping between renders. (A concurrent compact-mode commit had reverted this to
  // activity-order, which made projects jump whenever their updatedAt changed.)
  return groups.sort((a, b) => {
    const aTime = a.isTransient ? "9999" : a.createdAt;
    const bTime = b.isTransient ? "9999" : b.createdAt;
    const byCreation = aTime.localeCompare(bTime);
    return byCreation === 0 ? a.key.localeCompare(b.key) : byCreation;
  });
}

/**
 * Filters the sidebar read model by a search query (case-insensitive), matching a project's
 * displayName/displayPath OR a session's title. A group is kept when its project name/path matches
 * OR any of its sessions match; when the project itself matches, all its sessions are kept (the user
 * is looking at the project, not a single session). Matching groups are auto-expanded (collapsed set
 * to false) without mutating the source groups. Pure.
 */
export function filterProjectSidebar(
  groups: readonly ProjectGroup[],
  query: string,
): readonly ProjectGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return groups;
  }

  const out: ProjectGroup[] = [];
  for (const group of groups) {
    const projectMatches =
      group.displayName.toLowerCase().includes(q) || group.displayPath.toLowerCase().includes(q);

    if (projectMatches) {
      // Project matched: keep all sessions, force expanded.
      out.push({ ...group, collapsed: false });
      continue;
    }

    const matchingSessions = group.sessions.filter((s) =>
      s.summary.title.toLowerCase().includes(q),
    );
    if (matchingSessions.length > 0) {
      out.push({ ...group, sessions: matchingSessions, collapsed: false });
    }
  }
  return out;
}
