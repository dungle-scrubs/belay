import { decodeServerEnvelope, type SessionEvent } from "@trevor/richter";
import { Either } from "effect";

/**
 * Browser-native Richter participant client for Slice 0. Effect is used at the
 * decode boundary (wire.ts); the socket lifecycle is plain so it does not become
 * an Effect island fighting React. Reconnect/backoff and WS command correlation
 * arrive in later slices, mirroring Richter's ParticipantRuntimeClient.
 */

// Default to same-origin so requests go through the Vite dev proxy (vite.config.ts),
// which forwards /sessions (REST + WS) to Richter and avoids cross-origin (CORS)
// failures. Set VITE_RICHTER_URL to hit a Richter that serves CORS directly.
const SERVICE_URL = import.meta.env.VITE_RICHTER_URL ?? window.location.origin;

export type ConnectionStatus = "connecting" | "open" | "closed";

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

/** Builds the participant stream URL, mirroring Richter's query-param contract. */
function streamUrl(sessionId: string, afterSeq: number): string {
  const url = new URL(`/sessions/${sessionId}/stream`, SERVICE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("after", String(afterSeq));
  url.searchParams.set("capabilities", "{}");
  url.searchParams.set("displayName", "trevor-web");
  url.searchParams.set("instanceId", crypto.randomUUID());
  url.searchParams.set("participantId", `web-${crypto.randomUUID()}`);
  url.searchParams.set("runtimeKind", "web");
  return url.toString();
}

/** Opens a session stream (replay-then-tail) and decodes each envelope. */
export function connect(options: ConnectOptions): RichterConnection {
  const { sessionId, afterSeq = 0, onEvent, onReplayComplete, onStatus } = options;
  onStatus?.("connecting");
  const socket = new WebSocket(streamUrl(sessionId, afterSeq));

  socket.addEventListener("open", () => onStatus?.("open"));
  socket.addEventListener("close", () => onStatus?.("closed"));
  socket.addEventListener("message", (message) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(message.data));
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

export interface PublishInput {
  readonly type: string;
  readonly producerId: string;
  readonly payload: Record<string, unknown>;
}

/** Publishes one event to the durable log via REST; it returns over the stream. */
export async function publishEvent(sessionId: string, input: PublishInput): Promise<void> {
  const response = await fetch(`${SERVICE_URL}/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`publish failed: HTTP ${response.status}`);
  }
}

/** Ensures a Richter session with the given id exists (idempotent) and returns it. */
export async function ensureSession(sessionId: string): Promise<string> {
  const response = await fetch(`${SERVICE_URL}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) {
    throw new Error(`ensure session failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { session: { sessionId: string } };
  return body.session.sessionId;
}
