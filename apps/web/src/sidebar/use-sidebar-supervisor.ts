import {
  decodeTrevorEvent,
  type SessionEvent,
  type SessionTransport,
  SUPERVISOR_SESSION_ID,
  type SupervisorProject,
  events as sessionEvents,
  type TrevorEventInput,
} from "@trevor/session";
import { useCallback, useEffect, useRef, useState } from "react";
import { publishWebEvent, sessionTransport, useSessionWithTransport } from "@/session/use-session";
import type { ProjectSidebarRecord } from "@/sidebar/project-sidebar-model";
import type { ProjectAction } from "@/sidebar/use-project-sidebar";

/**
 * The sidebar's supervisor subscription (plan 58 M6): a persistent control-session subscription
 * that fetches + folds the project registry list and dispatches project actions (add/rename/
 * collapse/remove). Separate from the picker's {@link useSupervisor} (which gates on picker-open
 * and owns the launch machine) because the sidebar needs the project list whenever it is open, not
 * just during a launch.
 *
 * The project list is mapped from {@link SupervisorProject} (the wire type, which carries only
 * root/sessionId/updatedAt) to {@link ProjectSidebarRecord} (the read-model type, which also needs
 * displayPath/displayName/collapsed/createdAt). The supervisor's `projects.list.result` does not yet
 * carry the full registry fields, so displayPath/displayName are derived browser-side (basename) and
 * collapsed defaults to false; a future protocol change can carry the full record.
 */

/** Maps a supervisor project (wire type) to the sidebar read-model record. */
function toSidebarRecord(p: SupervisorProject): ProjectSidebarRecord {
  const basename = p.root.split("/").filter(Boolean).pop() ?? p.root;
  return {
    path: p.root,
    // displayPath: the raw root; the read model will canonicalize for grouping but display
    // should show what the user expects (the raw supervisor value).
    displayPath: p.root,
    displayName: basename,
    collapsed: false,
    createdAt: p.updatedAt,
    updatedAt: p.updatedAt,
  };
}

export interface UseSidebarSupervisorOptions {
  /** Whether the sidebar is open (gates the control-session subscription + projects fetch). */
  readonly active: boolean;
  /** Injected for deterministic hook tests; defaults to the shared browser transport singleton. */
  readonly transport?: SessionTransport;
}

export interface SidebarSupervisorController {
  /** The project registry records (mapped from the supervisor's projects.list.result). */
  readonly projects: readonly ProjectSidebarRecord[];
  /** Dispatch a supervisor project action (add/rename/collapse/remove). */
  readonly onProjectAction: (action: ProjectAction) => void;
}

export function useSidebarSupervisor(
  options: UseSidebarSupervisorOptions,
): SidebarSupervisorController {
  const { active } = options;
  const transport = options.transport ?? sessionTransport;

  // Subscribe to the supervisor control session only while the sidebar is open.
  const control = useSessionWithTransport(transport, active ? SUPERVISOR_SESSION_ID : null);
  const controlEvents = control.events;

  const [projects, setProjects] = useState<readonly ProjectSidebarRecord[]>([]);
  const projectsReqRef = useRef<string | null>(null);
  const cursorRef = useRef(0);

  const publish = useCallback(
    (built: TrevorEventInput): Promise<void> =>
      publishWebEvent(transport, SUPERVISOR_SESSION_ID, built),
    [transport],
  );

  // On open, ask the supervisor for the project list; on close, reset.
  useEffect(() => {
    if (!active) {
      setProjects([]);
      projectsReqRef.current = null;
      cursorRef.current = 0;
      return;
    }
    const requestId = crypto.randomUUID();
    projectsReqRef.current = requestId;
    void publish(sessionEvents.projectsListRequested({ requestId }));
  }, [active, publish]);

  // Fold each new control-session event once for the sidebar's concern (the project list).
  useEffect(() => {
    for (let i = cursorRef.current; i < controlEvents.length; i += 1) {
      const event = controlEvents[i];
      const decoded = event ? decodeTrevorEvent(event) : null;
      if (!decoded) {
        continue;
      }
      if (decoded.type === "projects.list.result" && decoded.requestId === projectsReqRef.current) {
        setProjects(decoded.projects.map(toSidebarRecord));
      }
    }
    cursorRef.current = controlEvents.length;
  }, [controlEvents]);

  const onProjectAction = useCallback(
    (action: ProjectAction) => {
      switch (action.type) {
        case "add": {
          const requestId = crypto.randomUUID();
          void publish(sessionEvents.projectAddRequested({ requestId }));
          break;
        }
        case "rename": {
          const requestId = crypto.randomUUID();
          void publish(
            sessionEvents.projectRenameRequested({
              requestId,
              path: action.path,
              displayName: action.displayName,
            }),
          );
          break;
        }
        case "collapse": {
          const requestId = crypto.randomUUID();
          void publish(
            sessionEvents.projectCollapseRequested({
              requestId,
              path: action.path,
              collapsed: action.collapsed,
            }),
          );
          break;
        }
        case "remove": {
          const requestId = crypto.randomUUID();
          void publish(sessionEvents.projectRemoveRequested({ requestId, path: action.path }));
          break;
        }
      }
    },
    [publish],
  );

  return { projects, onProjectAction };
}

/** Re-exported so a test can construct a SessionEvent for delivery without importing the type. */
export type { SessionEvent };
