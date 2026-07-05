/**
 * The reserved loopback ports the shared local services bind - the ONE source of truth for the whole
 * system. The launcher (trevor-cli) checks them, the stores bind them, the web dev server + /sessions
 * proxy and the host's blob client point at them. A port change edits only this object and propagates
 * to every surface; no literal shadows it. Per-callsite env-var overrides still win at runtime - this
 * is the fallback/default, not a hard binding. The human-facing registry is `~/.agents/PORTS.md`; this
 * mirrors it for code.
 *
 * Deliberately a zero-dependency leaf module exposed via the `@trevor/session/ports` subpath so the
 * Vite config and the dependency-free blob-store can import the constant without pulling in the rest
 * of the protocol package (and its `effect` dependency).
 */
export const RESERVED_PORTS = {
  web: 17420,
  blob: 17423,
  store: 17424,
  supervisor: 17425,
} as const;

/** A reserved shared-service name (`web` | `blob` | `store` | `supervisor`). */
export type ServiceName = keyof typeof RESERVED_PORTS;

/**
 * The default loopback URL a reserved service binds: `http://127.0.0.1:<reserved port>`. The single
 * owner of the host + reserved-port assembly that the launcher, host, web build, and blob client all
 * need - replacing the `http://127.0.0.1:${RESERVED_PORTS[name]}` strings reassembled per callsite
 * (and the lone hard-coded `17424`). Each consumer layers its own env override on top, e.g.
 * `process.env.SESSION_STORE_URL ?? serviceUrl("store")`; the override NAME stays at the callsite
 * because it is runtime-specific (node `process.env.BLOB_STORE_URL` vs the Vite client's
 * `VITE_BLOB_STORE_URL`). Stays zero-dependency so the `@trevor/session/ports` subpath consumers
 * (Vite config, dependency-free blob-store) can import it.
 */
export function serviceUrl(name: ServiceName): string {
  return `http://127.0.0.1:${RESERVED_PORTS[name]}`;
}
