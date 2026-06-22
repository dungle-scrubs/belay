import { Either } from "effect";
import { decodeServerEnvelope, type SessionEvent } from "./wire";

/**
 * The Richter participant transport, owned here so the host and the web client
 * stop each re-deriving Richter's HTTP/WebSocket contract. It builds the stream
 * URL, runs the replay-then-tail decode loop (unknown envelopes are ignored for
 * forward-compatibility), and posts events/sessions over REST.
 *
 * Isomorphic: `fetch`, `WebSocket`, and `URL` are globals in both the browser and
 * Node >= 22, so the same code serves the Vite app and the tsx host. The service
 * URL and the participant identity are injected (the browser reads them from Vite
 * env; the host from process env), so this module stays environment-agnostic.
 *
 * This is the single-connection primitive: it does not reconnect. Callers layer
 * their own reconnect policy (the host loops on close; the web relies on React
 * effect re-runs), since each owns different per-connection state.
 */

export type ConnectionStatus = "connecting" | "open" | "closed";

/** Who this participant is on the stream (mirrors Richter's query-param contract). */
export interface SessionIdentity {
  readonly displayName: string;
  readonly runtimeKind: string;
  readonly instanceId: string;
  readonly participantId: string;
  readonly capabilities?: Record<string, unknown>;
}

export interface ConnectSessionOptions {
  readonly serviceUrl: string;
  readonly sessionId: string;
  readonly identity: SessionIdentity;
  readonly afterSeq?: number;
  readonly onEvent: (event: SessionEvent) => void;
  readonly onReplayComplete?: () => void;
  readonly onStatus?: (status: ConnectionStatus) => void;
}

export interface SessionConnection {
  readonly close: () => void;
}

/** Builds the participant stream URL (ws/wss), with Richter's query params. */
function streamUrl(
  serviceUrl: string,
  sessionId: string,
  identity: SessionIdentity,
  afterSeq: number,
): string {
  const url = new URL(`/sessions/${sessionId}/stream`, serviceUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("after", String(afterSeq));
  url.searchParams.set("capabilities", JSON.stringify(identity.capabilities ?? {}));
  url.searchParams.set("displayName", identity.displayName);
  url.searchParams.set("instanceId", identity.instanceId);
  url.searchParams.set("participantId", identity.participantId);
  url.searchParams.set("runtimeKind", identity.runtimeKind);
  return url.toString();
}

/** Opens one session stream (replay-then-tail) and decodes each envelope. */
export function connectSession(options: ConnectSessionOptions): SessionConnection {
  const {
    serviceUrl,
    sessionId,
    identity,
    afterSeq = 0,
    onEvent,
    onReplayComplete,
    onStatus,
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
    const decoded = decodeServerEnvelope(raw);
    if (Either.isLeft(decoded)) {
      return; // unknown/forward-compat envelope: ignore rather than crash
    }
    const envelope = decoded.right;
    if (envelope.op === "event") {
      onEvent(envelope.event);
    } else if (envelope.op === "replay.complete") {
      onReplayComplete?.();
    }
  });

  return { close: () => socket.close() };
}

/** One event to publish to the durable log over REST. */
export interface PublishInput {
  readonly type: string;
  readonly producerId: string;
  readonly payload: Record<string, unknown>;
}

/** Publishes one event to the durable log via REST; it returns over the stream. */
export async function publishEvent(
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

/** Ensures a Richter session with the given id exists (idempotent); returns its id. */
export async function ensureSession(serviceUrl: string, sessionId: string): Promise<string> {
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
