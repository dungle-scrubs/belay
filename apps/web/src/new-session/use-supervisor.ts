import {
  decodeTrevorEvent,
  PRODUCER_IDS,
  type SessionEvent,
  type SessionTransport,
  SUPERVISOR_SESSION_ID,
  type SupervisorProject,
  events as sessionEvents,
  type TrevorEventInput,
  viewerIdentity,
} from "@trevor/session";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sessionTransport, useSessionWithTransport } from "@/session/use-session";
import type { LaunchPhase, PathValidation } from "./new-session-picker";
import { validatePath } from "./path-validation";

/**
 * The New-session picker's live wiring over the 44.1 supervisor contract (plan 44.2 M3/M4). This hook
 * is the single seam that owns the browser<->supervisor request/response handling on the reserved
 * control session and the launch state machine, so `app.tsx` stays thin and 44.3 extends ONE state
 * model (idle -> starting -> online) rather than forking a second one.
 *
 * It reads the SUPERVISOR_SESSION_ID control session and publishes typed requests stamped with
 * `PRODUCER_IDS.web` (the same publish model as `requestFileIndex`), correlating each result to its
 * request by a minted `requestId`:
 *   - opening the picker publishes `projects.list.requested` and renders the returned recents;
 *   - the folder icon publishes `folder.pick.requested` and fills the path from `folder.pick.result`
 *     (a no-op on cancel), gated on a local supervisor being present;
 *   - `Create` (or picking a recent) publishes `session.launch.requested { root }`, enters
 *     "starting host…", and - for a freshly `launched` host - awaits that session's `host.online`
 *     before navigating; a `reused` host navigates immediately; a `failed` launch surfaces a plain
 *     inline error (44.3 formalizes recovery).
 */

/** How long to wait for a freshly launched host's `host.online` before giving up the auto-navigate. */
const HOST_ONLINE_TIMEOUT_MS = 30_000;

const isHostOnline = (event: SessionEvent): boolean =>
  decodeTrevorEvent(event)?.type === "host.online";

export interface UseSupervisorOptions {
  /** Whether the picker is open. Gates the control-session subscription and drives the projects fetch
   *  on open + the state reset on close. */
  readonly active: boolean;
  /** Whether a local supervisor is present (the current session reports presence): offers the native
   *  folder pick. A remote/headless backend degrades to recents + paste-a-path. */
  readonly localPickerAvailable: boolean;
  /** Navigate to the launched/reused session (the app also closes the picker here). */
  readonly onNavigate: (sessionId: string) => void;
  /** Injected for deterministic hook tests; defaults to the shared browser transport singleton. */
  readonly transport?: SessionTransport;
  /** Injected for deterministic hook tests. */
  readonly hostOnlineTimeoutMs?: number;
}

export interface SupervisorController {
  readonly recents: readonly SupervisorProject[];
  readonly path: string;
  readonly validation: PathValidation;
  readonly launchState: LaunchPhase;
  readonly error: string | null;
  readonly onPathChange: (path: string) => void;
  readonly onPickFolder: () => void;
  readonly onPickRecent: (root: string) => void;
  readonly onCreate: (root: string) => void;
}

export function useSupervisor(options: UseSupervisorOptions): SupervisorController {
  const { active, localPickerAvailable, onNavigate } = options;
  const transport = options.transport ?? sessionTransport;
  const hostOnlineTimeoutMs = options.hostOnlineTimeoutMs ?? HOST_ONLINE_TIMEOUT_MS;

  // The control session is subscribed only while the picker is open (like the inventory fetch), so a
  // closed picker holds no stream. Publishing goes to the SAME reserved session id.
  const control = useSessionWithTransport(transport, active ? SUPERVISOR_SESSION_ID : null);
  const controlEvents = control.events;

  const [recents, setRecents] = useState<readonly SupervisorProject[]>([]);
  const [path, setPath] = useState("");
  const [launchState, setLaunchState] = useState<LaunchPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  // Pending request ids live in refs (correlation, not render state); a cursor tracks which control
  // events have been folded so each result is handled once. A launch token invalidates a pending
  // host.online wait when the picker resets, so a cancelled launch never navigates late.
  const projectsReqRef = useRef<string | null>(null);
  const folderReqRef = useRef<string | null>(null);
  const launchReqRef = useRef<string | null>(null);
  const launchTokenRef = useRef(0);
  const cursorRef = useRef(0);
  // The latest navigate callback, read from the async host.online continuation without making it an
  // effect dependency (the app may pass a fresh closure each render).
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;

  // A stable viewer identity for the host.online watch (the same shape the launcher uses).
  const watchIdentity = useMemo(() => {
    const id = `web-supervisor-${crypto.randomUUID()}`;
    return viewerIdentity({ displayName: "trevor-web", instanceId: id, participantId: id });
  }, []);

  const publish = useCallback(
    (built: TrevorEventInput): Promise<void> =>
      transport.publishEvent(SUPERVISOR_SESSION_ID, { producerId: PRODUCER_IDS.web, ...built }),
    [transport],
  );

  const resetState = useCallback(() => {
    setRecents([]);
    setPath("");
    setLaunchState("idle");
    setError(null);
    projectsReqRef.current = null;
    folderReqRef.current = null;
    launchReqRef.current = null;
    launchTokenRef.current += 1; // invalidate any pending host.online navigation
    cursorRef.current = 0;
  }, []);

  // On open, ask the supervisor for the recent project roots; on close, reset every request + state.
  useEffect(() => {
    if (!active) {
      resetState();
      return;
    }
    const requestId = crypto.randomUUID();
    projectsReqRef.current = requestId;
    void publish(sessionEvents.projectsListRequested({ requestId }));
  }, [active, publish, resetState]);

  const launch = useCallback(
    (root: string) => {
      const requestId = crypto.randomUUID();
      launchReqRef.current = requestId;
      setError(null);
      setLaunchState("starting");
      void publish(sessionEvents.sessionLaunchRequested({ requestId, root }));
    },
    [publish],
  );

  // Fold each new control-session event once, dispatching the result to its pending request. A freshly
  // launched host is awaited on its OWN session (host.online) before navigating; a reused host
  // navigates at once; a failed launch drops back to idle with a plain inline error.
  useEffect(() => {
    for (let i = cursorRef.current; i < controlEvents.length; i += 1) {
      const decoded = decodeTrevorEvent(controlEvents[i] as SessionEvent);
      if (!decoded) {
        continue;
      }
      if (decoded.type === "projects.list.result" && decoded.requestId === projectsReqRef.current) {
        setRecents(decoded.projects);
      } else if (
        decoded.type === "folder.pick.result" &&
        decoded.requestId === folderReqRef.current
      ) {
        folderReqRef.current = null;
        if (!decoded.cancelled && decoded.path) {
          setPath(decoded.path);
        }
      } else if (
        decoded.type === "session.launch.result" &&
        decoded.requestId === launchReqRef.current
      ) {
        launchReqRef.current = null;
        if (decoded.status === "failed") {
          setError(decoded.error ?? "The session could not be started.");
          setLaunchState("idle");
        } else if (decoded.status === "reused") {
          navigateRef.current(decoded.sessionId);
        } else {
          launchTokenRef.current += 1;
          const token = launchTokenRef.current;
          const targetSessionId = decoded.sessionId;
          void transport
            .awaitEvent(targetSessionId, watchIdentity, isHostOnline, {
              timeoutMs: hostOnlineTimeoutMs,
            })
            .then(() => {
              if (launchTokenRef.current === token) {
                navigateRef.current(targetSessionId);
              }
            });
        }
      }
    }
    cursorRef.current = controlEvents.length;
  }, [controlEvents, transport, watchIdentity, hostOnlineTimeoutMs]);

  const onPickFolder = useCallback(() => {
    if (!localPickerAvailable) {
      return;
    }
    const requestId = crypto.randomUUID();
    folderReqRef.current = requestId;
    void publish(sessionEvents.folderPickRequested({ requestId }));
  }, [localPickerAvailable, publish]);

  return {
    recents,
    path,
    validation: validatePath(path),
    launchState,
    error,
    onPathChange: setPath,
    onPickFolder,
    onPickRecent: launch,
    onCreate: launch,
  };
}
