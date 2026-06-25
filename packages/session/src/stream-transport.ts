import { Either } from "effect";
import { decodeStreamEnvelope } from "./envelope";
import type {
  ConnectSessionOptions,
  PublishInput,
  SessionConnection,
  SessionIdentity,
  SessionTransport,
} from "./transport";

/**
 * The default session transport: a `SessionTransport` over HTTP + WebSocket,
 * speaking the `/sessions` REST + `/sessions/{id}/stream` contract that both the
 * local session-store and the Richter service implement. It builds the stream URL,
 * runs the replay-then-tail decode loop (unknown envelopes are ignored for
 * forward-compatibility), and posts events/sessions over REST.
 *
 * Isomorphic: `fetch`, `WebSocket`, and `URL` are globals in both the browser and
 * Node >= 22, so the same client serves the Vite app, the host, and tests. Point
 * it at a local store for local sessions, or at Richter (@trevor/richter) for the
 * durable substrate - the wire is identical, so the choice is just the URL.
 *
 * Single-connection: it does not reconnect. Callers layer their own reconnect
 * policy (the host loops on close; the web relies on React effect re-runs), since
 * each owns different per-connection state.
 */

/**
 * Encodes the participant identity + replay cursor as the `/sessions/{id}/stream`
 * query params, and `decodeStreamParams` reads them back. The builder (here) and the
 * server's parser share this one codec so a renamed/added param can't silently desync
 * them - the store would otherwise read an empty string and drop the host from
 * presence. NOTE: these names are also the wire contract the external Richter service
 * implements, so a participant reaches either backend unchanged; centralizing removes
 * client<->local-store drift but does NOT make the names free to rename unilaterally.
 */
export function encodeStreamParams(identity: SessionIdentity, afterSeq: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set("after", String(afterSeq));
  params.set("capabilities", JSON.stringify(identity.capabilities ?? {}));
  params.set("displayName", identity.displayName);
  params.set("instanceId", identity.instanceId);
  params.set("participantId", identity.participantId);
  params.set("runtimeKind", identity.runtimeKind);
  return params;
}

/** Parses the stream query params back into an identity + cursor (see encodeStreamParams). */
export function decodeStreamParams(params: URLSearchParams): {
  readonly identity: SessionIdentity;
  readonly afterSeq: number;
} {
  let capabilities: Record<string, unknown> = {};
  try {
    capabilities = JSON.parse(params.get("capabilities") ?? "{}") as Record<string, unknown>;
  } catch {
    capabilities = {};
  }
  return {
    afterSeq: Number(params.get("after") ?? 0) || 0,
    identity: {
      displayName: params.get("displayName") ?? "",
      runtimeKind: params.get("runtimeKind") ?? "",
      instanceId: params.get("instanceId") ?? "",
      participantId: params.get("participantId") ?? "",
      capabilities,
    },
  };
}

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
