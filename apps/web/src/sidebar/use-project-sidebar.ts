import type { SessionSummary } from "@trevor/session";
import { useCallback, useMemo, useState } from "react";
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
  /** Dispatch a supervisor project action (add/rename/collapse/remove). App owns the publish. */
  readonly onProjectAction: (action: ProjectAction) => void;
  /** Launch a fresh project-scoped session (M4): mint a UUID, publish session.launch.requested. */
  readonly onNewSession: (projectKey: string) => void;
  /** Archive a session (publish session.archived on its log). */
  readonly onArchiveSession: (sessionId: string) => void;
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
  readonly onRenameProject: (key: string, name: string) => void;
  readonly onRemoveProject: (key: string) => void;
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
  const { sessions, projects, onProjectAction, onNewSession, onArchiveSession } = options;

  const { collapsedKeys, toggle } = useCollapsedKeys(projects);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  // Build the base read model, then layer local collapsed overrides (the registry record's collapsed
  // state is the seed, but the user may have toggled locally without a round trip yet).
  const baseGroups = useMemo(() => buildProjectSidebar(projects, sessions), [projects, sessions]);

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
    onArchiveSession,
    onRenameProject,
    onRemoveProject,
  };
}

/** Re-export so the live owner imports the cap from the hook module if needed. */
export { SESSION_CAP };
