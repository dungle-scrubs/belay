import type {
  ConnectSessionOptions,
  PublishInput,
  SessionConnection,
  SessionIdentity,
  SessionTransport,
} from "@trevor/session";
import { Either } from "effect";
import { decodeServerEnvelope } from "./envelope";

/**
 * The Richter transport: binds Trevor's SessionTransport contract to a Richter
 * service over its HTTP/WebSocket protocol. This is the Richter plug-in - the host
 * and web select it by constructing `richterTransport(url)`, and nothing outside
 * this package speaks Richter's wire. It builds the stream URL, runs the
 * replay-then-tail decode loop (unknown envelopes are ignored for
 * forward-compatibility), and posts events/sessions over REST.
 *
 * Isomorphic: `fetch`, `WebSocket`, and `URL` are globals in both the browser and
 * Node >= 22, so the same code serves the Vite app and the tsx host.
 *
 * Single-connection: it does not reconnect. Callers layer their own reconnect
 * policy (the host loops on close; the web relies on React effect re-runs), since
 * each owns different per-connection state.
 */

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

/** Opens one Richter session stream (replay-then-tail) and decodes each envelope. */
function connectRichter(serviceUrl: string, options: ConnectSessionOptions): SessionConnection {
  const { sessionId, identity, afterSeq = 0, onEvent, onReplayComplete, onStatus } = options;
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

/** Publishes one event to the durable log via REST; it returns over the stream. */
async function publishRichter(
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
async function ensureRichter(serviceUrl: string, sessionId: string): Promise<string> {
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
 * The Richter transport plug-in, bound to one Richter service URL. Implements the
 * shared SessionTransport so participants depend on the contract, not on Richter.
 */
export function richterTransport(serviceUrl: string): SessionTransport {
  return {
    ensureSession: (sessionId) => ensureRichter(serviceUrl, sessionId),
    publishEvent: (sessionId, input) => publishRichter(serviceUrl, sessionId, input),
    connectSession: (options) => connectRichter(serviceUrl, options),
  };
}
