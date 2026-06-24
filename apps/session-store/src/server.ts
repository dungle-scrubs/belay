import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { type AppendInput, SessionLog } from "./log";

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
          const input = body as Partial<AppendInput>;
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
          broadcast(sessionId, { op: "event", event: stored });
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
    const afterSeq = Number(url.searchParams.get("after") ?? 0) || 0;

    // Synchronous replay-then-subscribe: the node:sqlite reads and the subscribe
    // are all synchronous on the single event-loop thread, so no append can
    // interleave between the replay snapshot and joining the live fan-out.
    for (const event of log.readAfter(sessionId, afterSeq)) {
      socket.send(JSON.stringify({ op: "event", event }));
    }
    socket.send(JSON.stringify({ op: "replay.complete" }));
    subscribe(sessionId, socket);

    socket.on("close", () => unsubscribe(sessionId, socket));
  });

  return server;
}
