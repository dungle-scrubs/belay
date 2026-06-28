import { Either } from "effect";
import { decodeStreamEnvelope } from "./envelope";
import { encodeStreamParams } from "./identity";
import type {
  ConnectSessionOptions,
  PublishInput,
  SessionConnection,
  SessionIdentity,
  SessionTransport,
} from "./transport";

/**
 * The stream-param codec (the URL identity + cursor wire contract) is owned beside the
 * identity vocabulary it serializes; re-exported here for API continuity, so the client
 * builder below and the store both read it from one place (see ./identity).
 */
export { decodeStreamParams, encodeStreamParams } from "./identity";

/**
 * The default session transport: a `SessionTransport` over HTTP + WebSocket,
 * speaking the `/sessions` REST + `/sessions/{id}/stream` contract that both the
 * local session-store and the Richter service implement. It builds the stream URL,
 * runs the replay-then-tail decode loop (unknown envelopes are ignored for
 * forward-compatibility), and posts events/sessions over REST.
 *
 * Isomorphic: `fetch`, `WebSocket`, and `URL` are globals in both the browser and
 * Node >= 22, so the same client serves the Vite app, the host, and tests. Point
 * it at a local store for local sessions, or at a Richter service for the durable
 * substrate - the wire is identical, so the choice is just the URL.
 *
 * Single-connection: it does not reconnect. Callers layer their own reconnect
 * policy (the host loops on close; the web relies on React effect re-runs), since
 * each owns different per-connection state.
 */

/** Builds the participant stream URL (ws/wss), with the identity query params. */
function streamUrl(
  serviceUrl: string,
  sessionId: string,
  identity: SessionIdentity,
  afterSeq: number,
): string {
  const url = new URL(`/sessions/${sessionId}/stream`, serviceUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = encodeStreamParams(identity, afterSeq).toString();
  return url.toString();
}

/** Opens one session stream (replay-then-tail) and decodes each envelope. */
function connectStream(serviceUrl: string, options: ConnectSessionOptions): SessionConnection {
  const {
    sessionId,
    identity,
    afterSeq = 0,
    onEvent,
    onReplayComplete,
    onStatus,
    onPresence,
  } = options;
  onStatus?.("connecting");
  const socket = new WebSocket(streamUrl(serviceUrl, sessionId, identity, afterSeq));

  socket.addEventListener("open", () => onStatus?.("open"));
  socket.addEventListener("close", () => onStatus?.("closed"));
  socket.addEventListener("message", (message) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String((message as { data: unknown }).data));
    } catch {
      return;
    }
    const decoded = decodeStreamEnvelope(raw);
    if (Either.isLeft(decoded)) {
      return; // unknown/forward-compat envelope: ignore rather than crash
    }
    const envelope = decoded.right;
    if (envelope.op === "event") {
      onEvent(envelope.event);
    } else if (envelope.op === "replay.complete") {
      onReplayComplete?.();
    } else if (envelope.op === "presence") {
      onPresence?.(envelope.hosts);
    }
  });

  return { close: () => socket.close() };
}

/** Publishes one event to the durable log via REST; it returns over the stream. */
async function publishStream(
  serviceUrl: string,
  sessionId: string,
  input: PublishInput,
): Promise<void> {
  const response = await fetch(`${serviceUrl}/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`publish failed: HTTP ${response.status}`);
  }
}

/** Ensures a session with the given id exists (idempotent); returns its id. */
async function ensureStreamSession(serviceUrl: string, sessionId: string): Promise<string> {
  const response = await fetch(`${serviceUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) {
    throw new Error(`ensure session failed: HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as {
    session?: { sessionId?: string };
  } | null;
  return body?.session?.sessionId ?? sessionId;
}

/**
 * Builds a `SessionTransport` bound to one service URL (a local store or Richter).
 * The host and web depend on the `SessionTransport` contract; this is the concrete
 * client that carries it over the wire.
 */
export function streamTransport(serviceUrl: string): SessionTransport {
  return {
    ensureSession: (sessionId) => ensureStreamSession(serviceUrl, sessionId),
    publishEvent: (sessionId, input) => publishStream(serviceUrl, sessionId, input),
    connectSession: (options) => connectStream(serviceUrl, options),
  };
}
