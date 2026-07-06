/**
 * The session-store / Tether HTTP route vocabulary: the `/sessions` REST + stream path grammar and
 * the `/diag` self-check contract, owned ONCE so the store's server matchers, the client's URL
 * builders, the host doctor's probe, and the web dev proxy can't drift. The sibling identity.ts
 * already centralized the per-request PARAM codec (the `?after=` cursor + stream identity); these
 * are the path segments + wire shapes, the un-owned half it was missing. Mirrors RESERVED_PORTS'
 * single-ownership.
 *
 * Zero-dependency (strings, regexes, and wire-shape types only) and exposed via the
 * `@trevor/session/session-routes` subpath, so the Vite config can import the proxy path without
 * pulling in the rest of the package.
 */

/** The session collection route: POST to create a session, GET for the inventory read model. */
export const SESSIONS_PATH = "/sessions";

/** The store self-check route (plan 45.2 M1): GET returns {@link StoreDiagPayload}. Deliberately
 *  distinct from server-kit's cheap `/health` liveness probe - operators and the host /doctor read
 *  this drift-sensitive payload; launchers keep probing the bare liveness body. */
export const DIAG_PATH = "/diag";

/**
 * The `GET /diag` wire payload - the store's drift self-check (plan 45.2 M1), owned here beside its
 * route so the store's producer (`SessionLog.diag`), the server route, and the host doctor's decoder
 * can never drift field-by-field. `startupSha` is the git HEAD the store process booted from (null
 * outside a checkout); `indexHealthy` reports the hot type-lookup index; the query counters are
 * process-lifetime totals.
 */
export interface StoreDiagPayload {
  readonly indexHealthy: boolean;
  readonly queries: number;
  readonly schemaVersion: number;
  readonly slowQueries: number;
  readonly startupSha: string | null;
}

/** The per-session events route a participant POSTs one event to. */
export function eventsPath(sessionId: string): string {
  return `${SESSIONS_PATH}/${sessionId}/events`;
}

/** The per-session stream route (WebSocket, replay-then-tail). */
export function streamPath(sessionId: string): string {
  return `${SESSIONS_PATH}/${sessionId}/stream`;
}

/** The per-session PERMANENT-delete route (plan 04): POSTed to purge an archived session's storage.
 *  A dedicated path (not the soft-delete `session.deleted` event) so the destructive op is distinct. */
export function deletePath(sessionId: string): string {
  return `${SESSIONS_PATH}/${sessionId}/delete`;
}

/** The server-side matcher for {@link eventsPath}, capturing the (encoded) session id. */
export const EVENTS_PATTERN = /^\/sessions\/([^/]+)\/events$/;

/** The server-side matcher for {@link streamPath}, capturing the (encoded) session id. */
export const STREAM_PATTERN = /^\/sessions\/([^/]+)\/stream$/;

/** The server-side matcher for {@link deletePath}, capturing the (encoded) session id. */
export const DELETE_PATTERN = /^\/sessions\/([^/]+)\/delete$/;
