import {
  type ConnectionStatus,
  connectSession,
  ensureSession as ensureSessionRemote,
  type PublishInput,
  publishEvent as publishEventRemote,
  type SessionEvent,
  type SessionIdentity,
} from "@trevor/richter";

/**
 * Web binding for the shared Richter participant transport (@trevor/richter): it
 * resolves the service URL from Vite env and stamps a fresh web identity onto each
 * connection. The stream URL, decode loop, and REST calls live in the package, so
 * the host and the browser cannot drift on Richter's contract.
 */

// Default to same-origin so requests go through the Vite dev proxy (vite.config.ts),
// which forwards /sessions (REST + WS) to Richter and avoids cross-origin (CORS)
// failures. Set VITE_RICHTER_URL to hit a Richter that serves CORS directly.
const SERVICE_URL = import.meta.env.VITE_RICHTER_URL ?? window.location.origin;

export type { ConnectionStatus, PublishInput };

export interface ConnectOptions {
  readonly sessionId: string;
  readonly afterSeq?: number;
  readonly onEvent: (event: SessionEvent) => void;
  readonly onReplayComplete?: () => void;
  readonly onStatus?: (status: ConnectionStatus) => void;
}

export interface RichterConnection {
  readonly close: () => void;
}

// Identity is per-tab and persisted in sessionStorage, so a page reload reuses it
// instead of registering a new Richter participant on every load. sessionStorage
// (not localStorage) scopes it to this tab, keeping distinct tabs and devices as
// distinct presences - a session moves between machines by URL (?session=), never
// by identity. Storage can throw (private mode); we fall back to an ephemeral id.
const IDENTITY_KEY = "trevor-web-identity";

function webIdentity(): SessionIdentity {
  try {
    const cached = sessionStorage.getItem(IDENTITY_KEY);
    if (cached) {
      return JSON.parse(cached) as SessionIdentity;
    }
  } catch {
    // storage unavailable: fall through to a fresh, non-persisted identity
  }

  const identity: SessionIdentity = {
    displayName: "trevor-web",
    runtimeKind: "web",
    instanceId: crypto.randomUUID(),
    participantId: `web-${crypto.randomUUID()}`,
  };

  try {
    sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // ignore: an ephemeral identity still works for this load
  }

  return identity;
}

/** Opens a session stream as this tab's stable web participant (replay-then-tail). */
export function connect(options: ConnectOptions): RichterConnection {
  return connectSession({
    serviceUrl: SERVICE_URL,
    sessionId: options.sessionId,
    afterSeq: options.afterSeq,
    identity: webIdentity(),
    onEvent: options.onEvent,
    onReplayComplete: options.onReplayComplete,
    onStatus: options.onStatus,
  });
}

/** Publishes one event to the durable log via REST; it returns over the stream. */
export function publishEvent(sessionId: string, input: PublishInput): Promise<void> {
  return publishEventRemote(SERVICE_URL, sessionId, input);
}

/** Ensures a Richter session with the given id exists (idempotent) and returns it. */
export function ensureSession(sessionId: string): Promise<string> {
  return ensureSessionRemote(SERVICE_URL, sessionId);
}
