import type { SessionActivity, WorktreeSummary } from "@trevor/session";
import { useLocalStorageState } from "ahooks";
import { useMemo, useRef, useState } from "react";
import type { HostStatus } from "../derive";
import { workspaceBasename } from "../derive";
import { useInventory } from "../resume";
import type { WorktreeActivity } from "../worktrees";

/** The project sidebar's default width (px) - the seed for the persisted preference and the value a
 *  double-click on the resize handle snaps back to. */
export const DEFAULT_SIDEBAR_WIDTH = 352;

export function useModalState(opts: {
  readonly worktrees: readonly WorktreeSummary[];
  readonly host: HostStatus;
  readonly target: string;
  readonly sessionId: string | null;
  readonly busy: boolean;
}) {
  // The explicit resume chooser (D-090): a UI affordance / `/resume` opens it; currentProject below
  // orders + groups its sessions first.
  const [resumeOpen, setResumeOpen] = useState(false);
  // The New-session picker (plan 44.2, D-001): the sidebar `＋` / `/new` opens it; it drives a
  // folder-bound launch over the 44.1 supervisor contract.
  const [newOpen, setNewOpen] = useState(false);
  // The managed-worktree switcher (D-091): a UI affordance / `/worktree` opens it; the host
  // announces the worktrees on host.online, and switching routes the host-owned switch action.
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  // The archive browser (plan 04): a transcript-takeover for managing archived sessions, opened from
  // the sidebar footer. It reads the same inventory (its rows are the archived sessions).
  const [archiveOpen, setArchiveOpen] = useState(false);
  // The left-side project sidebar (plan 58) is toggleable; defaults open and persists. Keyed v2
  // to drop the retired session-sidebar's stored `false`, so the new default takes effect on
  // first load rather than being suppressed by a stale preference.
  const [sidebarOpen, setSidebarOpen] = useLocalStorageState<boolean>("trevor.sidebar.v2", {
    defaultValue: true,
  });
  // The sidebar width is draggable (plan 58 polish): persisted across reloads, clamped to a
  // usable range so it can't collapse to nothing or eat the whole viewport.
  const [sidebarWidth, setSidebarWidth] = useLocalStorageState<number>("trevor.sidebar.width", {
    defaultValue: DEFAULT_SIDEBAR_WIDTH,
  });
  // The right-side panel is toggleable; remember the choice across reloads.
  const [panelOpen, setPanelOpen] = useLocalStorageState<boolean>("trevor.panel", {
    defaultValue: true,
  });

  // The session inventory powers the resume chooser, decorates worktree rows, backs the sidebar, and
  // (plan 04) supplies the archive browser's archived rows.
  const inventory = useInventory(resumeOpen || worktreeOpen || archiveOpen || Boolean(sidebarOpen));
  const resolvedProject = useMemo(() => {
    return (
      workspaceBasename(opts.host.workspace ?? opts.host.cwd) ??
      inventory.sessions.find((s) => s.sessionId === opts.target)?.project ??
      null
    );
  }, [opts.host.workspace, opts.host.cwd, inventory.sessions, opts.target]);
  const lastKnownProjectRef = useRef<string | null>(null);
  if (resolvedProject != null) {
    lastKnownProjectRef.current = resolvedProject;
  }
  const currentProject = resolvedProject ?? lastKnownProjectRef.current;
  const worktreeActivity = useMemo(() => {
    const map = new Map<string, WorktreeActivity>();
    for (const s of inventory.sessions) {
      map.set(s.sessionId, { host: s.host, activity: s.activity });
    }
    return map;
  }, [inventory.sessions]);
  const sidebarLiveActivity = useMemo(() => {
    const map = new Map<string, SessionActivity>();
    if (opts.sessionId && opts.busy) {
      map.set(opts.sessionId, "running");
    }
    return map;
  }, [opts.sessionId, opts.busy]);

  return {
    resumeOpen,
    setResumeOpen,
    newOpen,
    setNewOpen,
    worktreeOpen,
    setWorktreeOpen,
    archiveOpen,
    setArchiveOpen,
    sidebarOpen: Boolean(sidebarOpen),
    setSidebarOpen,
    sidebarWidth: sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH,
    setSidebarWidth,
    panelOpen: Boolean(panelOpen),
    setPanelOpen,
    inventory,
    currentProject,
    worktrees: opts.worktrees,
    worktreeActivity,
    sidebarLiveActivity,
  };
}
