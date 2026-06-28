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
export const RESERVED_PORTS = { web: 17420, blob: 17423, store: 17424 } as const;

/** A reserved shared-service name (`web` | `blob` | `store`). */
export type ServiceName = keyof typeof RESERVED_PORTS;
