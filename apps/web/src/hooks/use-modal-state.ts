import type { SessionActivity, SessionEvent } from "@trevor/session";
import { useLocalStorageState } from "ahooks";
import { useMemo, useRef, useState } from "react";
import type { HostStatus } from "../derive";
import { workspaceBasename, worktreesFrom } from "../derive";
import { useInventory } from "../resume";

export function useModalState(opts: {
  readonly events: readonly SessionEvent[];
  readonly host: HostStatus;
  readonly target: string;
  readonly sessionId: string | null;
  readonly busy: boolean;
}) {
  // The explicit resume chooser (D-090): a UI affordance / `/resume` opens it; currentProject below
  // orders + groups its sessions first.
  const [resumeOpen, setResumeOpen] = useState(false);
  // The managed-worktree switcher (D-091): a UI affordance / `/worktree` opens it; the host
  // announces the worktrees on host.online, and switching routes the host-owned switch action.
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  // The left-side session sidebar (D-093) is toggleable; starts collapsed and persists.
  const [sidebarOpen, setSidebarOpen] = useLocalStorageState<boolean>("trevor.sidebar", {
    defaultValue: false,
  });
  // The right-side panel is toggleable; remember the choice across reloads.
  const [panelOpen, setPanelOpen] = useLocalStorageState<boolean>("trevor.panel", {
    defaultValue: true,
  });

  // The session inventory powers the resume chooser, decorates worktree rows, and backs the sidebar.
  const inventory = useInventory(resumeOpen || worktreeOpen || Boolean(sidebarOpen));
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
  const worktrees = useMemo(() => worktreesFrom(opts.events), [opts.events]);
  const worktreeActivity = useMemo(() => {
    const map = new Map<string, { host: "live" | "stale" | "none"; activity: SessionActivity }>();
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
    worktreeOpen,
    setWorktreeOpen,
    sidebarOpen: Boolean(sidebarOpen),
    setSidebarOpen,
    panelOpen: Boolean(panelOpen),
    setPanelOpen,
    inventory,
    currentProject,
    worktrees,
    worktreeActivity,
    sidebarLiveActivity,
  };
}
