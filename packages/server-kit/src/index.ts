/**
 * @trevor/server-kit - the shared transport layer for Trevor's local stores.
 *
 * It owns two things, both purely at the HTTP/socket level:
 *   - HTTP helpers: `cors`, `json`, `readJson`, `readBody` (request/response plumbing).
 *   - Server lifecycle: `startServer` / `RunningServer` (bind a loopback port, expose the
 *     resolved URL/port, and a single `close()` teardown; production and tests share it).
 *
 * It is deliberately NOT: it knows nothing about sessions, blobs, routes, databases, or
 * any other domain. The stores build their own `node:http` server and routes, then lean
 * on this kit for the boilerplate they would otherwise each re-implement. Zero runtime
 * dependencies - Node built-ins only.
 */

export { cors, json, readBody, readJson } from "./http";
export { type RunningServer, type StartServerOptions, startServer } from "./server";
