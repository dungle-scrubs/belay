import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createService, json, type Route, readJson } from "@trevor/server-kit";
import {
  decodeStreamParams,
  EVENTS_PATTERN,
  frames,
  type HostPresence,
  type PublishInput,
  RUNTIME_KIND,
  SESSIONS_PATH,
  STREAM_PATTERN,
  summarizeSession,
} from "@trevor/session";
import { type WebSocket, WebSocketServer } from "ws";
import { SessionLog } from "./log";

/**
 * Builds the local session-store HTTP + WebSocket server over a SQLite log,
 * without listening - so `main.ts` can bind the configured port and tests can bind
 * an ephemeral one against a throwaway database. The server speaks the SAME
 * `/sessions` REST + `/sessions/{id}/stream` contract Richter does, so the shared
 * client (@trevor/session streamTransport) reaches either with only a URL change.
 *
 *   POST  /sessions                      { sessionId }                 -> { session: { sessionId } }
 *   POST  /sessions/<id>/events          { type, producerId, payload } -> { ok, seq }
 *   GET   /sessions/<id>/stream?after=N  (WebSocket)                   -> replay (seq>N) then live tail
 *   GET   /health                        -> { ok: true }
 *
 * The stream is replay-then-tail: on connect we send every event with seq>after as
 * `{op:"event"}`, then `{op:"replay.complete"}`, then add the socket to the live
 * fan-out. node:sqlite is synchronous and the loop single-threaded, so replay and
 * subscribe happen with no append interleaving - a joiner never misses or reorders
 * an event.
 */

// The runtimeKind the agent-host declares on its stream identity (RUNTIME_KIND.host,
// owned in @trevor/session). Presence tracks THIS runtime - "is a host connected right
// now" - so a browser (RUNTIME_KIND.web) joining never counts as a host.
const HOST_RUNTIME = RUNTIME_KIND.host;

// The browser (trevor-web :17420) reads/writes cross-origin; the store serves GET/POST.
const CORS_METHODS = "GET, POST, OPTIONS";

/** Creates the session-store server backed by the SQLite log at `dbPath` (not listening). */
export function createSessionStore(dbPath: string): Server {
  const log = new SessionLog(dbPath);

  // Live subscribers per session, fed by appends; a socket is removed on close.
  const subscribers = new Map<string, Set<WebSocket>>();

  const subscribe = (sessionId: string, socket: WebSocket): void => {
    const set = subscribers.get(sessionId) ?? new Set<WebSocket>();
    set.add(socket);
    subscribers.set(sessionId, set);
  };

  const unsubscribe = (sessionId: string, socket: WebSocket): void => {
    const set = subscribers.get(sessionId);
    if (!set) {
      return;
    }
    set.delete(socket);
    if (set.size === 0) {
      subscribers.delete(sessionId);
    }
  };

  const broadcast = (sessionId: string, frame: unknown): void => {
    const set = subscribers.get(sessionId);
    if (!set) {
      return;
    }
    const data = JSON.stringify(frame);
    for (const socket of set) {
      if (socket.readyState === socket.OPEN) {
        socket.send(data);
      }
    }
  };

  // Hosts (the agent-host runtime) connected per session, keyed by socket. This is the
  // LIVE source of presence: a host appears when its stream opens and is gone the instant
  // the socket closes (crash, kill, lost connection) - which the latched host.online
  // events in the durable log can never reflect. Browsers are not tracked here.
  const hosts = new Map<string, Map<WebSocket, HostPresence>>();

  // The distinct hosts live for a session. Deduped by instanceId, since a reconnecting
  // host can momentarily hold both its old and new socket.
  const hostsOf = (sessionId: string): HostPresence[] => {
    const set = hosts.get(sessionId);
    if (!set) {
      return [];
    }
    const byId = new Map<string, HostPresence>();
    for (const presence of set.values()) {
      byId.set(presence.instanceId, presence);
    }
    return [...byId.values()];
  };

  const addHost = (sessionId: string, socket: WebSocket, presence: HostPresence): void => {
    const set = hosts.get(sessionId) ?? new Map<WebSocket, HostPresence>();
    set.set(socket, presence);
    hosts.set(sessionId, set);
  };

  const removeHost = (sessionId: string, socket: WebSocket): boolean => {
    const set = hosts.get(sessionId);
    if (!set?.delete(socket)) {
      return false;
    }
    if (set.size === 0) {
      hosts.delete(sessionId);
    }
    return true;
  };

  const broadcastPresence = (sessionId: string): void =>
    broadcast(sessionId, frames.presence(hostsOf(sessionId)));

  // The store's domain routes; CORS, the OPTIONS preflight, GET /health, and the 404 fallthrough are
  // owned by createService. The stream (GET /sessions/<id>/stream) is a WebSocket, handled below.
  const routes: Route[] = [
    {
      method: "GET",
      match: SESSIONS_PATH,
      // The session inventory read model (D-090): each session's distilled summary, with live host
      // presence folded in from the in-memory socket map (the durable log can't know a host crashed).
      // Assembly is the pure summarizeSession; the store just supplies the rows + presence.
      handler: ({ res }) => {
        const sessions = log
          .inventory()
          .map((row) =>
            summarizeSession({ ...row, hostPresent: hostsOf(row.sessionId).length > 0 }),
          );
        json(res, 200, { sessions });
      },
    },
    {
      method: "POST",
      match: SESSIONS_PATH,
      handler: ({ req, res }) =>
        readJson(req)
          .then((body) => {
            const sessionId = (body as { sessionId?: unknown }).sessionId;
            if (typeof sessionId !== "string" || sessionId.length === 0) {
              json(res, 400, { error: "sessionId required" });
              return;
            }
            log.ensureSession(sessionId, new Date().toISOString());
            json(res, 200, { session: { sessionId } });
          })
          .catch(() => json(res, 400, { error: "invalid JSON body" })),
    },
    {
      method: "POST",
      match: EVENTS_PATTERN,
      handler: ({ req, res, params }) => {
        const sessionId = decodeURIComponent(params[0] as string);
        return readJson(req)
          .then((body) => {
            const input = body as Partial<PublishInput>;
            if (typeof input.type !== "string" || typeof input.producerId !== "string") {
              json(res, 400, { error: "type and producerId required" });
              return;
            }
            const stored = log.append(
              sessionId,
              {
                type: input.type,
                producerId: input.producerId,
                payload: (input.payload as Record<string, unknown>) ?? {},
              },
              randomUUID(),
              new Date().toISOString(),
            );
            // The event "returns over the stream": fan out to every subscriber, including the
            // publisher's own socket (matching the Richter round-trip). The log owns the wire
            // framing (D-023); the server just fans out the frame.
            for (const frame of log.readFrames(sessionId, stored.seq - 1)) {
              broadcast(sessionId, frame);
            }
            json(res, 201, { ok: true, seq: stored.seq });
          })
          .catch(() => json(res, 400, { error: "invalid JSON body" }));
      },
    },
  ];

  const server = createService({ routes, corsMethods: CORS_METHODS });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = STREAM_PATTERN.exec(url.pathname);
    if (!match) {
      socket.close();
      return;
    }
    const sessionId = decodeURIComponent(match[1] as string);

    // Identity + cursor ride the stream URL; decode them with the same codec the client
    // encodes with (@trevor/session) so the param names can't drift between the two. A
    // connection from the agent-host runtime counts toward presence; anything else (a
    // browser) only observes it.
    const { identity, afterSeq } = decodeStreamParams(url.searchParams);
    const { runtimeKind, instanceId, participantId, displayName } = identity;
    const isHost = runtimeKind === HOST_RUNTIME && instanceId.length > 0;

    // Synchronous replay-then-subscribe: the node:sqlite reads and the subscribe
    // are all synchronous on the single event-loop thread, so no append can
    // interleave between the replay snapshot and joining the live fan-out. The log
    // owns the wire framing (D-023); the server just sends the frames verbatim.
    for (const frame of log.readFrames(sessionId, afterSeq)) {
      socket.send(JSON.stringify(frame));
    }
    socket.send(JSON.stringify(frames.replayComplete()));
    subscribe(sessionId, socket);

    if (isHost) {
      // A host joined: record it, then push the new live set to everyone (this socket
      // included) so viewers flip to "host active" immediately.
      addHost(sessionId, socket, { instanceId, participantId, displayName });
      broadcastPresence(sessionId);
    } else {
      // A viewer joined: it just needs the current live set once (no host-set change,
      // so don't disturb the others).
      socket.send(JSON.stringify(frames.presence(hostsOf(sessionId))));
    }

    socket.on("close", () => {
      unsubscribe(sessionId, socket);
      // A host's socket closing IS the disconnect signal - drop it and tell everyone,
      // so a crashed/killed host stops showing as active within one round trip.
      if (isHost && removeHost(sessionId, socket)) {
        broadcastPresence(sessionId);
      }
    });
  });

  return server;
}
