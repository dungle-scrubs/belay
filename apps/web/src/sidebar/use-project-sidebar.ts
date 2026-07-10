import type { SessionSummary, WorktreeSummary } from "@trevor/session";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildProjectSidebar,
  filterProjectSidebar,
  type ProjectGroup,
  type ProjectSidebarRecord,
  SESSION_CAP,
} from "./project-sidebar-model";

/**
 * The live wiring for the project sidebar (plan 58 M6): joins the supervisor's project inventory
 * with the session-store inventory, owns local UI state (collapsed, show-more, search), and feeds
 * the presentational {@link ProjectSidebar} component.
 *
 * The hook is pure over its injected inputs (sessions + projects + action callbacks). App owns the
 * supervisor subscription and the session inventory fetch; this hook only groups, filters, and
 * manages the ephemeral sidebar state that does NOT need to survive a reload. The persisted
 * `collapsed` field is seeded from the registry record but toggled locally for instant feedback,
 * with a `project.collapse.requested` dispatched to durably persist.
 */

/** A supervisor project action the hook asks App to dispatch (add/rename/collapse/remove). */
export type ProjectAction =
  | { readonly type: "add" }
  | { readonly type: "rename"; readonly path: string; readonly displayName: string }
  | { readonly type: "collapse"; readonly path: string; readonly collapsed: boolean }
  | { readonly type: "remove"; readonly path: string };

export interface UseProjectSidebarOptions {
  /** Active sessions from the session inventory (session-store). */
  readonly sessions: readonly SessionSummary[];
  /** Project registry records (mapped from the supervisor's `projects.list.result`). */
  readonly projects: readonly ProjectSidebarRecord[];
  /**
   * Current-host worktree snapshot from the viewed session's latest `host.online` (plan 58.2).
   * Badge join is scoped to this list; it is not an all-project worktree index.
   */
  readonly worktrees?: readonly WorktreeSummary[];
  /** Dispatch a supervisor project action (add/rename/collapse/remove). App owns the publish. */
  readonly onProjectAction: (action: ProjectAction) => void;
  /** Launch a fresh project-scoped session (M4): mint a UUID, publish session.launch.requested. */
  readonly onNewSession: (projectKey: string) => void;
  /** Archive a session (publish session.archived on its log). Returning the publish promise lets the
   *  hook revert its optimistic row removal when the publish fails. */
  readonly onArchiveSession: (sessionId: string) => void | Promise<void>;
  /** Rename a session (publish session.title on its log). Returning the publish promise lets the
   *  hook revert its optimistic title when the publish fails. */
  readonly onRenameSession?: (sessionId: string, title: string) => void | Promise<void>;
}

export interface UseProjectSidebar {
  readonly groups: readonly ProjectGroup[];
  readonly searchQuery: string;
  readonly onSearch: (query: string) => void;
  readonly onToggleProject: (key: string) => void;
  readonly onShowMore: (key: string) => void;
  readonly onAddProject: () => void;
  readonly onNewSession: (projectKey: string) => void;
  readonly onArchiveSession: (sessionId: string) => void;
  readonly onRenameSession: (sessionId: string, title: string) => void;
  readonly onRenameProject: (key: string, name: string) => void;
  readonly onRemoveProject: (key: string) => void;
}

/** The optimistic per-session overlay: fields the user just changed that the polled inventory has not
 *  reflected yet. Applied over the matching summary before grouping, so the sidebar responds
 *  immediately instead of waiting out the 4s inventory poll. */
interface SessionOverride {
  readonly archived?: boolean;
  readonly title?: string;
}

/**
 * Owns the optimistic session overlay: archive/rename actions apply their effect to the read model
 * immediately, the injected publish runs in the background, a rejected publish reverts that field,
 * and an override drops once the polled inventory confirms it (so a later unarchive/rename from
 * another surface is never masked by a stale local override).
 */
function useSessionOverrides(sessions: readonly SessionSummary[]) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, SessionOverride>>(new Map());

  const applyOverride = useCallback((sessionId: string, patch: SessionOverride) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(sessionId, { ...prev.get(sessionId), ...patch });
      return next;
    });
  }, []);

  // Reverts one field, but only when the failed publish still owns it (`expected` is the value that
  // publish wrote): a stale rejection - an older rename losing to a newer one already overlaid, or a
  // slow publish for a session id that has since been reused - must not undo the newer action.
  const revertOverride = useCallback(
    <K extends keyof SessionOverride>(
      sessionId: string,
      field: K,
      expected: SessionOverride[K],
    ) => {
      setOverrides((prev) => {
        const current = prev.get(sessionId);
        if (current === undefined || current[field] !== expected) {
          return prev;
        }
        const { [field]: _dropped, ...rest } = current;
        const next = new Map(prev);
        if (Object.keys(rest).length > 0) {
          next.set(sessionId, rest);
        } else {
          next.delete(sessionId);
        }
        return next;
      });
    },
    [],
  );

  // Drop each override FIELD the inventory has caught up with (or every field, when the session
  // vanished entirely), so the durable data becomes the single source again as soon as it agrees.
  // Per field, not per entry: with an archive confirmed but a rename still pending, the archived
  // field must release immediately - holding it until the title also confirms would let a stale
  // archived:true keep hiding a row another surface has since unarchived.
  useEffect(() => {
    setOverrides((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      let changed = false;
      const next = new Map(prev);
      for (const [sessionId, override] of prev) {
        const summary = sessions.find((s) => s.sessionId === sessionId);
        if (summary === undefined) {
          next.delete(sessionId);
          changed = true;
          continue;
        }
        const pending: SessionOverride = {
          ...(override.archived !== undefined && summary.archived !== override.archived
            ? { archived: override.archived }
            : undefined),
          ...(override.title !== undefined && summary.title !== override.title
            ? { title: override.title }
            : undefined),
        };
        const pendingCount = Object.keys(pending).length;
        if (pendingCount === Object.keys(override).length) {
          continue;
        }
        changed = true;
        if (pendingCount > 0) {
          next.set(sessionId, pending);
        } else {
          next.delete(sessionId);
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  const overlaid = useMemo(() => {
    if (overrides.size === 0) {
      return sessions;
    }
    return sessions.map((summary) => {
      const override = overrides.get(summary.sessionId);
      return override === undefined ? summary : { ...summary, ...override };
    });
  }, [sessions, overrides]);

  return { overlaid, applyOverride, revertOverride };
}

/**
 * Manages local collapsed state seeded from the registry records. A project starts collapsed when
 * its record has `collapsed: true`; toggling flips the local state AND dispatches a
 * `project.collapse.requested` so the supervisor persists it. The local flip is immediate (no round
 * trip wait) so the chevron responds instantly.
 */
function useCollapsedKeys(projects: readonly ProjectSidebarRecord[]) {
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const p of projects) {
      if (p.collapsed) {
        initial.add(p.path);
      }
    }
    return initial;
  });

  const toggle = useCallback((key: string): boolean => {
    let nextCollapsed = false;
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        nextCollapsed = false;
      } else {
        next.add(key);
        nextCollapsed = true;
      }
      return next;
    });
    return nextCollapsed;
  }, []);

  return { collapsedKeys, toggle };
}

export function useProjectSidebar(options: UseProjectSidebarOptions): UseProjectSidebar {
  const {
    sessions,
    projects,
    worktrees,
    onProjectAction,
    onNewSession,
    onArchiveSession,
    onRenameSession,
  } = options;

  const { collapsedKeys, toggle } = useCollapsedKeys(projects);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  // Optimistic archive/rename (the inventory polls at 4s; the sidebar must not wait it out): the
  // action applies to the read model immediately, the publish runs behind it, and a failure reverts.
  const { overlaid, applyOverride, revertOverride } = useSessionOverrides(sessions);

  const handleArchiveSession = useCallback(
    (sessionId: string) => {
      applyOverride(sessionId, { archived: true });
      Promise.resolve(onArchiveSession(sessionId)).catch(() => {
        revertOverride(sessionId, "archived", true);
      });
    },
    [applyOverride, revertOverride, onArchiveSession],
  );

  const handleRenameSession = useCallback(
    (sessionId: string, title: string) => {
      applyOverride(sessionId, { title });
      Promise.resolve(onRenameSession?.(sessionId, title)).catch(() => {
        revertOverride(sessionId, "title", title);
      });
    },
    [applyOverride, revertOverride, onRenameSession],
  );

  // Build the base read model (groups + scoped worktree join), then layer local collapsed overrides
  // (the registry record's collapsed state is the seed, but the user may have toggled locally
  // without a round trip yet). worktrees is the current host snapshot only.
  const baseGroups = useMemo(
    () => buildProjectSidebar(projects, overlaid, worktrees),
    [projects, overlaid, worktrees],
  );

  const groupsWithLocalCollapse = useMemo(() => {
    return baseGroups.map((group) => ({
      ...group,
      collapsed: collapsedKeys.has(group.key) ? true : group.collapsed,
    }));
  }, [baseGroups, collapsedKeys]);

  // Apply search filtering (auto-expands matched groups without mutating persisted collapse state).
  const filteredGroups = useMemo(
    () => filterProjectSidebar(groupsWithLocalCollapse, searchQuery),
    [groupsWithLocalCollapse, searchQuery],
  );

  // When searching, reveal ALL matching sessions per group (bypass SESSION_CAP); otherwise respect
  // the per-project "Show more" expansion set.
  const groups = useMemo(() => {
    const searching = searchQuery.trim().length > 0;
    return filteredGroups.map((group) => {
      if (group.collapsed) {
        return group;
      }
      if (searching || expandedProjects.has(group.key)) {
        return { ...group, sessions: group.sessions };
      }
      // The presentational component slices to SESSION_CAP on its own; no change needed here.
      return group;
    });
  }, [filteredGroups, searchQuery, expandedProjects]);

  const onToggleProject = useCallback(
    (key: string) => {
      const nextCollapsed = toggle(key);
      onProjectAction({ type: "collapse", path: key, collapsed: nextCollapsed });
    },
    [toggle, onProjectAction],
  );

  const onShowMore = useCallback((key: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const onSearch = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  const onAddProject = useCallback(() => {
    onProjectAction({ type: "add" });
  }, [onProjectAction]);

  const onRenameProject = useCallback(
    (key: string, name: string) => {
      onProjectAction({ type: "rename", path: key, displayName: name });
    },
    [onProjectAction],
  );

  const onRemoveProject = useCallback(
    (key: string) => {
      onProjectAction({ type: "remove", path: key });
    },
    [onProjectAction],
  );

  return {
    groups,
    searchQuery,
    onSearch,
    onToggleProject,
    onShowMore,
    onAddProject,
    onNewSession,
    onArchiveSession: handleArchiveSession,
    onRenameSession: handleRenameSession,
    onRenameProject,
    onRemoveProject,
  };
}

/** Re-export so the live owner imports the cap from the hook module if needed. */
export { SESSION_CAP };
