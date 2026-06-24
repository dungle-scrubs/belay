import { richterTransport } from "@trevor/richter";
import type {
  ConnectionStatus,
  PublishInput,
  SessionConnection,
  SessionEvent,
  SessionIdentity,
} from "@trevor/session";

/**
 * Web binding for the session transport: it selects a backend (today the Richter
 * transport) from the configured service URL and stamps a fresh web identity onto
 * each connection. The stream URL, decode loop, and REST calls live in the
 * transport package, so the host and the browser cannot drift on the contract.
 */

// Default to same-origin so requests go through the Vite dev proxy (vite.config.ts),
// which forwards /sessions (REST + WS) to the backend and avoids cross-origin (CORS)
// failures. Set VITE_RICHTER_URL to hit a backend that serves CORS directly.
const SERVICE_URL = import.meta.env.VITE_RICHTER_URL ?? window.location.origin;

// Backend selection (the plugin seam): swap richterTransport for a local transport here.
const transport = richterTransport(SERVICE_URL);

export type { ConnectionStatus, PublishInput };

export interface ConnectOptions {
  readonly sessionId: string;
  readonly afterSeq?: number;
  readonly onEvent: (event: SessionEvent) => void;
  readonly onReplayComplete?: () => void;
  readonly onStatus?: (status: ConnectionStatus) => void;
}

// Identity is per-tab and persisted in sessionStorage, so a page reload reuses it
// instead of registering a new participant on every load. sessionStorage (not
// localStorage) scopes it to this tab, keeping distinct tabs and devices as
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
export function connect(options: ConnectOptions): SessionConnection {
  return transport.connectSession({
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
  return transport.publishEvent(sessionId, input);
}

/** Ensures a session with the given id exists (idempotent) and returns it. */
export function ensureSession(sessionId: string): Promise<string> {
  return transport.ensureSession(sessionId);
}
