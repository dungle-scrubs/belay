import type { SessionSummary } from "@trevor/session";

/**
 * The project sidebar read model (plan 58 M5): a pure grouping of active sessions under projects,
 * built from registry records + the session inventory. The browser owns this projection (per the
 * plan's boundaries); it never scans local state itself - it joins the registry (canonical-path-keyed
 * metadata, no session ids) with `SessionSummary`s by each session's resolved project path.
 *
 * Pure over injected inputs; no React, no live wiring (M6). A `ProjectGroup` is the unit the sidebar
 * renders: a project row with expand/collapse state plus the sessions nested under it.
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
  /** Active sessions under this project, newest activity first. */
  readonly sessions: readonly SessionSummary[];
  /** Count of active sessions (== sessions.length; named for the UI's count badge). */
  readonly activeCount: number;
  /** The max of the registry updatedAt and the project's session updatedAt values. */
  readonly updatedAt: string;
  /** ISO timestamp of first registration (creation order). */
  readonly createdAt: string;
}

/** The default number of sessions shown per project before a "Show more" affordance (M6). */
export const SESSION_CAP = 5;

/**
 * Resolves a session's project path (plan 58 M3): the durable `projectPath` marker wins, then
 * `workspace`, then `cwd`, then null for ungrouped sessions. Pure; null means "no project binding".
 */
export function sessionProjectPath(summary: SessionSummary): string | null {
  return summary.projectPath ?? summary.workspace ?? summary.cwd ?? null;
}

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
 * Ordering: creation order (oldest first), by the registry record's `createdAt`. Transient
 * projects (sessions with no registry record) sort after known projects. Sessions within a
 * project are sorted by `updatedAt` descending.
 */
export function buildProjectSidebar(
  projects: readonly ProjectSidebarRecord[],
  sessions: readonly SessionSummary[],
): readonly ProjectGroup[] {
  // Active sessions only: archived, deleted, AND tangents are excluded. Tangents surface only from
  // their parent session, never in ordinary top-level navigation (see activeSessions).
  const active = sessions.filter((s) => !s.archived && !s.deleted && !s.tangentOf);

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
  // with no project binding does not surface its own project row.
  const sessionsByPath = new Map<string, SessionSummary[]>();
  for (const summary of active) {
    const path = sessionProjectPath(summary);
    if (path == null) {
      continue;
    }
    const canon = canonicalizePath(path, allRawPaths);
    const list = sessionsByPath.get(canon);
    if (list) {
      list.push(summary);
    } else {
      sessionsByPath.set(canon, [summary]);
    }
  }

  // Merge known registry records with transient paths (sessions present but no record).
  const keys = new Set<string>([...byPath.keys(), ...sessionsByPath.keys()]);

  const groups: ProjectGroup[] = [];
  for (const key of keys) {
    const record = byPath.get(key);
    const projectSessions = (sessionsByPath.get(key) ?? []).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );

    // The aggregate updatedAt: the max of the registry record and all the project's sessions.
    const candidates = [record?.updatedAt ?? "", ...projectSessions.map((s) => s.updatedAt)];
    const updatedAt = candidates.reduce((max, v) => (v > max ? v : max), "");

    const isTransient = record == null;
    const displayName = record?.displayName ?? pathBasename(key);
    // Use the canonical key for display so the path matches what the user sees elsewhere (no `~`
    // when the absolute form is known).
    const displayPath = key;
    const collapsed = record?.collapsed ?? false;
    const createdAt = record?.createdAt ?? projectSessions[0]?.createdAt ?? updatedAt;

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
    });
  }

  // Creation order: oldest first (by the registry record's createdAt). Transient projects
  // (sessions without a registry record) sort after known projects so the pinned registry order
  // is stable; they order among themselves by their earliest session's createdAt.
  return groups.sort((a, b) => {
    const aTime = a.isTransient ? "9999" : a.createdAt;
    const bTime = b.isTransient ? "9999" : b.createdAt;
    return aTime.localeCompare(bTime);
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

    const matchingSessions = group.sessions.filter((s) => s.title.toLowerCase().includes(q));
    if (matchingSessions.length > 0) {
      out.push({ ...group, sessions: matchingSessions, collapsed: false });
    }
  }
  return out;
}
