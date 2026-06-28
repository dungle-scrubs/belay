import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { cors, json } from "./http";

/**
 * The request lifecycle every Trevor store repeats, owned in one place. `createService` builds a
 * `node:http` Server that, for each request: applies permissive CORS, answers the OPTIONS preflight
 * (204), serves `GET /health -> {ok:true}`, dispatches to the first matching route, and 404s when
 * nothing matches. A store therefore declares only its DOMAIN routes (`Route[]`) and writes no
 * CORS/health/preflight/404 plumbing.
 *
 * Deliberately narrow: it does NOT listen (that is `startServer`), does NOT read request bodies
 * (handlers call `readJson`/`readBody` for their own needs), and owns no domain knowledge. The
 * returned Server is a plain `node:http` Server, so a caller can still attach a `WebSocketServer` to
 * it (the session-store does, for its stream).
 */

/** The per-request context handed to a route handler. */
export interface ServiceRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  /** The request URL's pathname (query stripped). */
  readonly path: string;
  /** Capture groups from a RegExp `match` (in order); empty for a string match. */
  readonly params: readonly string[];
}

/** One route: the method + path it answers (an exact string or a RegExp with capture groups), and
 *  its handler. A handler owns its own success and domain-error responses; an unexpected rejection
 *  that escapes it is caught by the service as a generic 500 so one bad request never wedges a socket. */
export interface Route {
  readonly method: string;
  readonly match: string | RegExp;
  handler(ctx: ServiceRequest): void | Promise<void>;
}

export interface ServiceOptions {
  readonly routes: readonly Route[];
  /** The `access-control-allow-methods` value - each store allows a different verb set. */
  readonly corsMethods: string;
}

/** Resolves the capture groups a route's `match` yields for `path`, or null when it does not match. */
function matchRoute(match: string | RegExp, path: string): readonly string[] | null {
  if (typeof match === "string") {
    return match === path ? [] : null;
  }
  return match.exec(path)?.slice(1) ?? null;
}

/** Builds the store's HTTP server (not listening). See the module doc for the lifecycle it owns. */
export function createService(opts: ServiceOptions): Server {
  return createServer((req, res) => {
    cors(res, opts.corsMethods);
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

    for (const route of opts.routes) {
      if (route.method !== method) {
        continue;
      }
      const params = matchRoute(route.match, path);
      if (params) {
        Promise.resolve(route.handler({ req, res, method, path, params })).catch(() => {
          if (!res.headersSent) {
            json(res, 500, { error: "internal error" });
          }
        });
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });
}
