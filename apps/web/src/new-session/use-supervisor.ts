import {
  decodeTrevorEvent,
  PRODUCER_IDS,
  type SessionTransport,
  SUPERVISOR_SESSION_ID,
  type SupervisorProject,
  events as sessionEvents,
  type TrevorEventInput,
} from "@trevor/session";
import { useCallback, useEffect, useRef, useState } from "react";
import { sessionTransport, useSessionWithTransport } from "@/session/use-session";
import { type PathValidation, validatePath } from "./path-validation";
import { type LaunchController, type LaunchPhase, useLaunch } from "./use-launch";

/** Re-exported so existing consumers (the picker) keep importing the launch union from here; the model
 *  itself lives in `use-launch.ts`, the single owner shared with the session-view "start host". */
export type { LaunchPhase } from "./use-launch";

/**
 * The New-session picker's live wiring over the 44.1 supervisor contract (plan 44.2 M3/M4). This hook
 * owns the picker-only concerns - recents (`projects.list`), the native folder pick, path validation,
 * and the `active` (open) gate + reset - and delegates the launch itself to {@link useLaunch}, the ONE
 * launch state machine also driven by the 44.3 session-view "start host". So `app.tsx` stays thin and
 * the two launch surfaces cannot drift into two models.
 *
 * It reads the SUPERVISOR_SESSION_ID control session and publishes typed requests stamped with
 * `PRODUCER_IDS.web` (the same publish model as `requestFileIndex`), correlating each result to its
 * request by a minted `requestId`:
 *   - opening the picker publishes `projects.list.requested` and renders the returned recents;
 *   - the folder icon publishes `folder.pick.requested` and fills the path from `folder.pick.result`
 *     (a no-op on cancel), gated on a local supervisor being present;
 *   - `Create` (or picking a recent) delegates to `useLaunch.launch`, which publishes
 *     `session.launch.requested { root }`, enters "starting host…", and navigates on the outcome; a
 *     `failed` launch surfaces the error with an explicit `Retry` (`useLaunch.retry`).
 */

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
  /** Re-launch the last attempted root after a `failed` launch (delegates to {@link useLaunch}). */
  readonly onRetry: () => void;
}

export function useSupervisor(options: UseSupervisorOptions): SupervisorController {
  const { active, localPickerAvailable, onNavigate } = options;
  const transport = options.transport ?? sessionTransport;

  // The control session is subscribed only while the picker is open (like the inventory fetch), so a
  // closed picker holds no stream. Publishing goes to the SAME reserved session id.
  const control = useSessionWithTransport(transport, active ? SUPERVISOR_SESSION_ID : null);
  const controlEvents = control.events;

  // The shared launch machine: the picker owns the control subscription (gated on `active`) and hands
  // its events to useLaunch, so the picker's launch runs on the exact same model the session view does.
  const launcher: LaunchController = useLaunch({
    controlEvents,
    onNavigate,
    transport,
    ...(options.hostOnlineTimeoutMs !== undefined
      ? { hostOnlineTimeoutMs: options.hostOnlineTimeoutMs }
      : {}),
  });

  const [recents, setRecents] = useState<readonly SupervisorProject[]>([]);
  const [path, setPath] = useState("");

  // Pending request ids live in refs (correlation, not render state); a cursor tracks which control
  // events THIS hook has folded (projects + folder) so each is handled once. The launch result is folded
  // by useLaunch on its own cursor over the same event array.
  const projectsReqRef = useRef<string | null>(null);
  const folderReqRef = useRef<string | null>(null);
  const cursorRef = useRef(0);

  const publish = useCallback(
    (built: TrevorEventInput): Promise<void> =>
      transport.publishEvent(SUPERVISOR_SESSION_ID, { producerId: PRODUCER_IDS.web, ...built }),
    [transport],
  );

  const resetLaunch = launcher.reset;
  const resetState = useCallback(() => {
    setRecents([]);
    setPath("");
    projectsReqRef.current = null;
    folderReqRef.current = null;
    cursorRef.current = 0;
    resetLaunch();
  }, [resetLaunch]);

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

  // Fold each new control-session event once for the PICKER's concerns (recents + folder pick). The
  // launch result is handled by useLaunch's own fold, so this loop no longer touches it.
  useEffect(() => {
    for (let i = cursorRef.current; i < controlEvents.length; i += 1) {
      const event = controlEvents[i];
      const decoded = event ? decodeTrevorEvent(event) : null;
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
      }
    }
    cursorRef.current = controlEvents.length;
  }, [controlEvents]);

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
    launchState: launcher.launchState,
    error: launcher.error,
    onPathChange: setPath,
    onPickFolder,
    onPickRecent: launcher.launch,
    onCreate: launcher.launch,
    onRetry: launcher.retry,
  };
}
