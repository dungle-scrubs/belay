/**
 * The session-store / Tether HTTP route vocabulary: the `/sessions` REST + stream path grammar, owned
 * ONCE so the store's server matchers, the client's URL builders, and the web dev proxy can't drift.
 * The sibling identity.ts already centralized the per-request PARAM codec (the `?after=` cursor +
 * stream identity); these are the path segments, the un-owned half it was missing. Mirrors
 * RESERVED_PORTS' single-ownership.
 *
 * Zero-dependency (strings + regexes only) and exposed via the `@trevor/session/session-routes`
 * subpath, so the Vite config can import the proxy path without pulling in the rest of the package.
 */

/** The session collection route: POST to create a session, GET for the inventory read model. */
export const SESSIONS_PATH = "/sessions";

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
