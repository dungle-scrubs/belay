import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  decodeStreamParams,
  frames,
  type HostPresence,
  type PublishInput,
  RUNTIME_KIND,
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

const STREAM_PATH = /^\/sessions\/([^/]+)\/stream$/;
const EVENTS_PATH = /^\/sessions\/([^/]+)\/events$/;

// The runtimeKind the agent-host declares on its stream identity (RUNTIME_KIND.host,
// owned in @trevor/session). Presence tracks THIS runtime - "is a host connected right
// now" - so a browser (RUNTIME_KIND.web) joining never counts as a host.
const HOST_RUNTIME = RUNTIME_KIND.host;

/** Permissive CORS: the browser (trevor-web :17420) reads/writes cross-origin, no credentials. */
function cors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

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

  const server = createServer((req, res) => {
    cors(res);
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (path === "/sessions" && method === "POST") {
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
        .catch(() => json(res, 400, { error: "invalid JSON body" }));
      return;
    }
    const eventsMatch = EVENTS_PATH.exec(path);
    if (eventsMatch && method === "POST") {
      const sessionId = decodeURIComponent(eventsMatch[1] as string);
      readJson(req)
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
          // The event "returns over the stream": fan out to every subscriber,
          // including the publisher's own socket (matching the Richter round-trip).
          broadcast(sessionId, frames.event(stored));
          json(res, 201, { ok: true, seq: stored.seq });
        })
        .catch(() => json(res, 400, { error: "invalid JSON body" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = STREAM_PATH.exec(url.pathname);
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
    // interleave between the replay snapshot and joining the live fan-out.
    for (const event of log.readAfter(sessionId, afterSeq)) {
      socket.send(JSON.stringify(frames.event(event)));
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
