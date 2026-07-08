import {
  decodeTrevorEvent,
  type SessionEvent,
  type SessionTransport,
  SUPERVISOR_SESSION_ID,
  events as sessionEvents,
  viewerIdentity,
} from "@trevor/session";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { publishWebEvent, sessionTransport } from "@/session/use-session";

/**
 * The launch trajectory both launch surfaces render (plan 44.2 happy path + plan 44.3 recovery):
 * `idle -> starting -> online | failed -> (retry) starting`. `starting` is one phase; whether it reads
 * "starting host…" or "restarting host…" is a render-time label the caller chooses (a stale host that
 * was here before restarts), so there is no separate `stale` phase. This union is the ONE launch state
 * model - the picker (44.2) and the session-view "start host" (44.3) both drive it through {@link useLaunch}.
 */
export type LaunchPhase = "idle" | "starting" | "failed";

/** How long to wait for a freshly launched host's `host.online` before giving up the auto-navigate. */
const HOST_ONLINE_TIMEOUT_MS = 30_000;

const isHostOnline = (event: SessionEvent): boolean =>
  decodeTrevorEvent(event)?.type === "host.online";

export interface UseLaunchOptions {
  /**
   * The reserved supervisor control-session events. The CALLER owns the `connectSession` subscription
   * and its gate - the picker on `active` (open), the session view on a launch being armed - so ONE
   * launch machine serves both surfaces from a single result-fold, without a second subscription inside
   * the hook. The control log replays from seq 0, so a subscription opened the instant a launch starts
   * still catches the durable `session.launch.result`.
   */
  readonly controlEvents: readonly SessionEvent[];
  /** Navigate to the launched/reused session once it is ready (immediately for `reused`, after
   *  `host.online` for `launched`). In the session view this targets the session already in view, so it
   *  is a harmless no-op there - the live log flips the host badge to active on its own. */
  readonly onNavigate: (sessionId: string) => void;
  /** Injected for deterministic hook tests; defaults to the shared browser transport singleton. */
  readonly transport?: SessionTransport;
  /** Injected for deterministic hook tests. */
  readonly hostOnlineTimeoutMs?: number;
}

export interface LaunchController {
  readonly launchState: LaunchPhase;
  readonly error: string | null;
  /** True while a launch is in flight or has failed (idle is the only non-armed phase); the session-view
   *  caller keeps its control subscription armed while this is set so a `Retry` still folds its result. */
  readonly inFlight: boolean;
  /** Publish `session.launch.requested { root }` and enter `starting`. When `sessionId` +
   *  `projectPath` are provided (plan 58 M4), the supervisor launches a FRESH project-scoped
   *  session with a `session.project` marker instead of the deterministic projectSessionId(root). */
  readonly launch: (root: string, options?: { sessionId?: string; projectPath?: string }) => void;
  /** Re-publish the last attempted root (the failed/timed-out launch's), returning to `starting`. */
  readonly retry: () => void;
  /** Reset to idle (the picker-close path / a session switch); invalidates a pending host.online
   *  navigation so a superseded launch never navigates late. */
  readonly reset: () => void;
}

/**
 * The single launch primitive (plan 44.3 M2.7): owns the launch state machine, the
 * `session.launch.requested` publish, the `session.launch.result` fold (failed / reused / launched), and
 * the one-shot `host.online` watch that navigates a freshly launched host. Both the 44.2 New-session
 * picker (via `use-supervisor`) and the 44.3 no-host "start host" affordance (in `app.tsx`) consume this
 * hook, so recovery states (`failed`, `retry`, the restart label) extend ONE model rather than forking a
 * second one in the session view.
 */
export function useLaunch(options: UseLaunchOptions): LaunchController {
  const transport = options.transport ?? sessionTransport;
  const hostOnlineTimeoutMs = options.hostOnlineTimeoutMs ?? HOST_ONLINE_TIMEOUT_MS;
  const { controlEvents, onNavigate } = options;

  const [launchState, setLaunchState] = useState<LaunchPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  // Correlation + control refs (not render state): the pending launch's request id, the last root (for
  // retry), a token that invalidates a pending host.online wait when the launch is superseded/reset, and
  // a cursor tracking which control events have been folded so each result is handled exactly once.
  const launchReqRef = useRef<string | null>(null);
  const lastRootRef = useRef<string | null>(null);
  const lastOptionsRef = useRef<{ sessionId?: string; projectPath?: string }>({});
  const launchTokenRef = useRef(0);
  const cursorRef = useRef(0);
  // The latest navigate callback, read from the async host.online continuation without making it an
  // effect dependency (the caller may pass a fresh closure each render).
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;

  // A stable viewer identity for the host.online watch (the same shape the launcher uses).
  const watchIdentity = useMemo(() => {
    const id = `web-supervisor-${crypto.randomUUID()}`;
    return viewerIdentity({ displayName: "trevor-web", instanceId: id, participantId: id });
  }, []);

  const publish = useCallback(
    (root: string, options?: { sessionId?: string; projectPath?: string }) => {
      const requestId = crypto.randomUUID();
      launchReqRef.current = requestId;
      lastRootRef.current = root;
      lastOptionsRef.current = options ?? {};
      launchTokenRef.current += 1; // a fresh launch invalidates any prior pending host.online continuation
      setError(null);
      setLaunchState("starting");
      void publishWebEvent(
        transport,
        SUPERVISOR_SESSION_ID,
        sessionEvents.sessionLaunchRequested({
          requestId,
          root,
          ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options?.projectPath ? { projectPath: options.projectPath } : {}),
        }),
      );
    },
    [transport],
  );

  const retry = useCallback(() => {
    const root = lastRootRef.current;
    if (root !== null) {
      publish(root, lastOptionsRef.current);
    }
  }, [publish]);

  const reset = useCallback(() => {
    setLaunchState("idle");
    setError(null);
    launchReqRef.current = null;
    lastRootRef.current = null;
    lastOptionsRef.current = {};
    launchTokenRef.current += 1; // invalidate any pending host.online navigation
    cursorRef.current = 0;
  }, []);

  // Fold each new control-session event once, dispatching the `session.launch.result` to its pending
  // launch. A freshly launched host is awaited on its OWN session (host.online) before navigating; a
  // reused host navigates at once; a `failed` result surfaces the named error and stays in `failed` for
  // an explicit Retry; a launched host that never comes online drops back to idle with an inline error.
  useEffect(() => {
    for (let i = cursorRef.current; i < controlEvents.length; i += 1) {
      const event = controlEvents[i];
      const decoded = event ? decodeTrevorEvent(event) : null;
      if (!decoded) {
        continue;
      }
      if (decoded.type === "session.launch.result" && decoded.requestId === launchReqRef.current) {
        launchReqRef.current = null;
        if (decoded.status === "failed") {
          setError(decoded.error ?? "The session could not be started.");
          setLaunchState("failed");
        } else if (decoded.status === "reused") {
          // A reused host is already live: navigate at once, then drop to idle. The idle reset matters in
          // the session view, where navigating to the (already-viewed) reused session is a no-op - without
          // it the badge would hang on "starting" forever if presence never materializes (a stale reuse);
          // idle returns the "start host" affordance instead of a dead spinner.
          navigateRef.current(decoded.sessionId);
          setLaunchState("idle");
        } else {
          launchTokenRef.current += 1;
          const token = launchTokenRef.current;
          const targetSessionId = decoded.sessionId;
          // The host.online watch is one-shot but NOT cancellable (awaitEvent takes no AbortSignal), so a
          // superseded launch's watch lingers until host.online or the timeout - the token guard below keeps
          // it correct (no late navigate/setState); cancelling it cleanly is a transport follow-up.
          void transport
            .awaitEvent(targetSessionId, watchIdentity, isHostOnline, {
              timeoutMs: hostOnlineTimeoutMs,
            })
            .then((online) => {
              if (launchTokenRef.current !== token) {
                return; // this launch was superseded (reset / a newer launch) - do not navigate late
              }
              if (online) {
                navigateRef.current(targetSessionId);
              } else {
                // host.online never arrived within the window (a host that failed to come online, a
                // dropped stream). Give up the auto-navigate instead of landing on a host-less session;
                // idle+error lets the user re-initiate through the same affordance.
                setLaunchState("idle");
                setError("The host did not come online in time. Try again.");
              }
            });
        }
      }
    }
    cursorRef.current = controlEvents.length;
  }, [controlEvents, transport, watchIdentity, hostOnlineTimeoutMs]);

  return {
    launchState,
    error,
    inFlight: launchState !== "idle",
    launch: publish,
    retry,
    reset,
  };
}
