import { randomUUID } from "node:crypto";
import type { Server, ServerResponse } from "node:http";
import { createService, json, type Route, readJson } from "@belay/server-kit";
import {
  DELETE_PATTERN,
  DIAG_PATH,
  decodeStreamParams,
  EVENTS_PATTERN,
  frames,
  type InventoryRow,
  type PermanentDeleteResult,
  type PublishInput,
  permanentDeleteEligibility,
  RUNTIME_KIND,
  SESSIONS_PATH,
  type SessionSummary,
  STREAM_PATTERN,
  summarizeSession,
} from "@belay/session";
import { createTelemetrySink } from "@belay/session/telemetry-file-sink";
import { WebSocketServer } from "ws";
import { InventoryProjection } from "./inventory";
import { SessionLog, StoreCircuitOpenError } from "./log";
import { SessionHub } from "./session-hub";

/**
 * Builds the local session-store HTTP + WebSocket server over a SQLite log,
 * without listening - so `main.ts` can bind the configured port and tests can bind
 * an ephemeral one against a throwaway database. The server speaks the SAME
 * `/sessions` REST + `/sessions/{id}/stream` contract Tether does, so the shared
 * client (@belay/session streamTransport) reaches either with only a URL change.
 *
 *   POST  /sessions                      { sessionId }                 -> { session: { sessionId } }
 *   POST  /sessions/<id>/events          { type, producerId, payload } -> { ok, seq }
 *   GET   /sessions/<id>/stream?after=N  (WebSocket)                   -> replay (seq>N) then live tail
 *   GET   /diag                          -> store self-check payload
 *   GET   /health                        -> { ok: true }
 *
 * The stream is replay-then-tail: on connect we send every event with seq>after as
 * `{op:"event"}`, then `{op:"replay.complete"}`, then add the socket to the live
 * fan-out. node:sqlite is synchronous and the loop single-threaded, so replay and
 * subscribe happen with no append interleaving - a joiner never misses or reorders
 * an event.
 */

// The runtimeKind the agent-host declares on its stream identity (RUNTIME_KIND.host,
// owned in @belay/session). Presence tracks THIS runtime - "is a host connected right
// now" - so a browser (RUNTIME_KIND.web) joining never counts as a host.
const HOST_RUNTIME = RUNTIME_KIND.host;

// The browser (belay-web :17420) reads/writes cross-origin; the store serves GET/POST.
const CORS_METHODS = "GET, POST, OPTIONS";

// WebSocket close code 1013 "Try Again Later" - the stream-side twin of the HTTP 503 below.
const WS_TRY_AGAIN_LATER = 1013;

/** Maps the log's typed circuit-breaker fast-fail to HTTP 503 (plan 45.2 M3): graceful degradation, not
 *  a crash or a misleading 400/500. Returns whether the error was handled so route catch-alls can keep
 *  owning their own domain errors. `/health` and `GET /sessions` (in-memory projection) and `/diag` never
 *  touch the gated log, so liveness and the drift doctor stay answerable while the circuit is open. */
function respondIfOverloaded(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof StoreCircuitOpenError)) {
    return false;
  }
  json(res, 503, { error: "store overloaded", retryAfterMs: error.retryAfterMs });
  return true;
}

/**
 * The session-store's assembled parts: the HTTP+WS `server` plus the `log` (durable substrate) and the
 * `projection` (in-memory read model) it serves `GET /sessions` from. Exposed by {@link buildSessionStore}
 * so tests/diagnostics can inspect the durable query counter and the read model directly; the port-binding
 * entrypoint and most callers use {@link createSessionStore}, which returns only the server.
 */
export interface SessionStore {
  readonly server: Server;
  readonly log: SessionLog;
  readonly projection: InventoryProjection;
}

/** Creates the session-store server backed by the SQLite log at `dbPath` (not listening). */
export function createSessionStore(dbPath: string): Server {
  return buildSessionStore(dbPath).server;
}

/** Test-only injection points for {@link buildSessionStore}. */
export interface SessionStoreOptions {
  /** The clock the log times queries (and the breaker cooldown) with; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Builds the session-store and returns its parts (server + log + read model), for wiring and for tests
 *  that assert on the durable query counter / projection state. `createSessionStore` is the server-only view. */
export function buildSessionStore(dbPath: string, options: SessionStoreOptions = {}): SessionStore {
  // Telemetry is off (NOOP) unless BELAY_OTEL_EXPORTER=file selects the local exporter (plan 13 M5).
  const log = new SessionLog(dbPath, createTelemetrySink("session-store"), options.now);
  const hub = new SessionHub();

  // The in-memory inventory read model (plan 45.1, D-002): warmed once here by a single durable scan,
  // then kept current on every write below, so GET /sessions is O(sessions) in memory with zero SQLite.
  const projection = new InventoryProjection(log);

  // Projects one inventory row into a SessionSummary, folding in live host presence from the socket map
  // (the durable log can't know a host crashed). Shared by GET /sessions (every row) and the delete gate
  // (one row), so the two never drift on how presence is folded in.
  const summarize = (row: Omit<InventoryRow, "hostPresent">): SessionSummary =>
    summarizeSession({ ...row, hostPresent: hub.hasLiveHost(row.sessionId) });

  // The store's domain routes; CORS, the OPTIONS preflight, GET /health, and the 404 fallthrough are
  // owned by createService. The stream (GET /sessions/<id>/stream) is a WebSocket, handled below.
  const routes: Route[] = [
    {
      method: "GET",
      match: DIAG_PATH,
      // Rich store health is intentionally separate from server-kit's cheap `/health` probe. Operators
      // and /doctor read this drift-sensitive payload; launchers keep probing the bare liveness body.
      handler: ({ res }) => {
        json(res, 200, log.diag());
      },
    },
    {
      method: "GET",
      match: SESSIONS_PATH,
      // The session inventory read model (D-090): each session's distilled summary, with live host
      // presence folded in from the in-memory socket map (the durable log can't know a host crashed).
      // Served from the in-memory projection (plan 45.1) - zero SQLite per poll; assembly is the pure
      // summarizeSession, the store just supplies the rows + presence.
      handler: ({ res }) => {
        json(res, 200, { sessions: projection.rows().map(summarize) });
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
            // One creation time feeds both the durable row and the projection so they can't disagree on
            // createdAt (both are INSERT-OR-IGNORE idempotent, so a re-ensure keeps the original time).
            const createdAt = new Date().toISOString();
            log.ensureSession(sessionId, createdAt);
            projection.ensure(sessionId, createdAt);
            json(res, 200, { session: { sessionId } });
          })
          .catch((error) => {
            if (!respondIfOverloaded(res, error)) {
              json(res, 400, { error: "invalid JSON body" });
            }
          }),
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
            // Fold the append into the in-memory read model (plan 45.1) so the next GET /sessions
            // reflects it without a scan; the stored event carries the seq/createdAt the projection needs.
            projection.recordAppend(stored);
            // The event "returns over the stream": fan out to every subscriber, including the
            // publisher's own socket (matching the Tether round-trip). Framed with the same shared
            // `frames.event` the log's replay framing (D-023) maps through - a log test pins the
            // equivalence - rather than re-reading the log: the admitted write is ONE breaker scope
            // (plan 45.2 M3), so a trip during the append's own statements can't strand a stored
            // event behind a fast-failed re-read (a 503 for a write that actually landed).
            hub.publish(sessionId, frames.event(stored));
            json(res, 201, { ok: true, seq: stored.seq });
          })
          .catch((error) => {
            if (!respondIfOverloaded(res, error)) {
              json(res, 400, { error: "invalid JSON body" });
            }
          });
      },
    },
    {
      // Permanent delete (plan 04): purge an archived session's storage. Gated by the SHARED eligibility
      // (archived, no live host, no active turn) so the store is the authoritative gate, then the rows
      // are removed from SQLite for good - distinct from the soft-delete `session.deleted` marker.
      method: "POST",
      match: DELETE_PATTERN,
      handler: ({ res, params }) => {
        const sessionId = decodeURIComponent(params[0] as string);
        try {
          const row = log.summaryRow(sessionId);
          const verdict = permanentDeleteEligibility(row ? summarize(row) : null);
          if (!verdict.ok) {
            const status = verdict.reason === "not-found" ? 404 : 409;
            json(res, status, {
              ok: false,
              reason: verdict.reason,
              detail: verdict.detail,
            } satisfies PermanentDeleteResult);
            return;
          }
          log.deleteSession(sessionId);
          projection.remove(sessionId);
          json(res, 200, { ok: true, sessionId } satisfies PermanentDeleteResult);
        } catch (error) {
          if (!respondIfOverloaded(res, error)) {
            throw error;
          }
        }
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
    // encodes with (@belay/session) so the param names can't drift between the two. A
    // connection from the agent-host runtime counts toward presence; anything else (a
    // browser) only observes it.
    const { identity, afterSeq } = decodeStreamParams(url.searchParams);
    const { runtimeKind, instanceId, participantId, displayName } = identity;
    const isHost = runtimeKind === HOST_RUNTIME && instanceId.length > 0;

    // Synchronous replay-then-subscribe: the node:sqlite reads and the subscribe
    // are all synchronous on the single event-loop thread, so no append can
    // interleave between the replay snapshot and joining the live fan-out. The log
    // owns the wire framing (D-023); the server just sends the frames verbatim.
    // An open circuit (plan 45.2 M3) fast-fails the replay read: degrade by closing
    // the socket with 1013 "Try Again Later" (the client reconnects after the
    // cooldown) instead of crashing the whole store on an unhandled throw.
    try {
      for (const frame of log.readFrames(sessionId, afterSeq)) {
        socket.send(JSON.stringify(frame));
      }
    } catch (error) {
      if (error instanceof StoreCircuitOpenError) {
        socket.close(WS_TRY_AGAIN_LATER, "store overloaded");
        return;
      }
      throw error;
    }
    socket.send(JSON.stringify(frames.replayComplete()));
    hub.attach(
      sessionId,
      socket,
      isHost ? { host: { instanceId, participantId, displayName } } : {},
    );

    socket.on("close", () => {
      hub.detach(sessionId, socket);
    });
  });

  return { server, log, projection };
}
