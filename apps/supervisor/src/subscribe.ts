import {
  errorMessage,
  PRODUCER_IDS,
  type SessionConnection,
  type SessionTransport,
  SUPERVISOR_SESSION_ID,
  viewerIdentity,
} from "@trevor/session";
import { handleSupervisorEvent, type SupervisorDeps } from "./dispatch";

/**
 * Subscribes the supervisor to the reserved control session (replay-then-tail) and drives each LIVE
 * request through the dispatcher, with a simple reconnect on socket close.
 *
 * The replay gate is load-bearing: the store replays the WHOLE control-session log on every (re)connect,
 * and re-dispatching that history would re-pop native folder dialogs, re-run past launches, and publish
 * duplicate results. So events seen during replay are ignored; only events that arrive AFTER
 * `onReplayComplete` are acted on. A request that arrived while the daemon was down is therefore not
 * retried here - the browser owns retry (plan 44.3). Reconnect re-gates: each new connection starts
 * not-live and replays again.
 *
 * A dispatch rejection (a transport error mid-handler) is caught here so it can never become an
 * unhandled promise rejection that takes the daemon down.
 */
export function subscribeControlSession(
  transport: SessionTransport,
  deps: SupervisorDeps,
  options: {
    readonly instanceId: string;
    readonly log?: (message: string, fields?: Record<string, unknown>) => void;
    /** Fires each time a (re)connect finishes replay and goes live (used by tests; a diagnostic hook). */
    readonly onReplayComplete?: () => void;
  },
): { readonly stop: () => void } {
  const { instanceId, log, onReplayComplete } = options;
  let connection: SessionConnection | undefined;
  let stopped = false;

  const connect = (): void => {
    if (stopped) {
      return;
    }
    let live = false;
    connection = transport.connectSession({
      sessionId: SUPERVISOR_SESSION_ID,
      identity: viewerIdentity({
        displayName: "trevor-supervisor",
        instanceId,
        participantId: PRODUCER_IDS.supervisor,
      }),
      onEvent: (event) => {
        if (!live) {
          return;
        }
        handleSupervisorEvent(event, deps).catch((error: unknown) =>
          log?.("dispatch failed", { error: errorMessage(error) }),
        );
      },
      onReplayComplete: () => {
        live = true;
        onReplayComplete?.();
      },
      onStatus: (status) => {
        if (status === "open") {
          log?.("subscribed to control session", { session: SUPERVISOR_SESSION_ID });
        } else if (status === "closed" && !stopped) {
          log?.("control session closed; reconnecting", { ms: 1000 });
          setTimeout(connect, 1000);
        }
      },
    });
  };

  connect();
  return {
    stop: () => {
      stopped = true;
      connection?.close();
    },
  };
}
