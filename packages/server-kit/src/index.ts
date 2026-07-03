/**
 * @trevor/server-kit - the shared transport layer for Trevor's local stores.
 *
 * It owns three things, all purely at the HTTP/socket level:
 *   - HTTP helpers: `cors`, `json`, `readJson`, `readBody` (request/response plumbing).
 *   - Request lifecycle: `createService(routes)` builds a server that owns CORS, the OPTIONS
 *     preflight, `GET /health`, route dispatch, and the 404 fallthrough, so a store writes only
 *     its domain routes.
 *   - Server lifecycle: `startServer` / `RunningServer` (bind a loopback port, expose the
 *     resolved URL/port, and a single `close()` teardown; production and tests share it).
 *
 * It is deliberately NOT: it knows nothing about sessions, blobs, databases, or any other
 * domain. The stores declare their routes, then lean on this kit for the boilerplate they
 * would otherwise each re-implement.
 */

export { cors, json, readBody, readJson } from "./http";
export { type RunningServer, type StartServerOptions, startServer } from "./server";
export {
  createService,
  HEALTH_BODY,
  HEALTH_PATH,
  isHealthBody,
  type Route,
  type ServiceOptions,
  type ServiceRequest,
} from "./service";
export { type StartStoreOptions, startStore } from "./store";
