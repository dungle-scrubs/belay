import { RESERVED_PORTS, type ServiceName, serviceUrl } from "@belay/session/ports";

/**
 * Shared-service readiness for the launcher (D-085). The web UI, blob store, session-store, and
 * supervisor are shared local services (one set across all projects, on reserved loopback ports) - the
 * launcher checks them before starting a project host, starts any that are missing, and flags a
 * reserved port that some OTHER process has taken. The classification is pure over an injected probe
 * result; the actual HTTP probing lives in the platform.
 *
 * The reserved ports themselves are owned by `@belay/session/ports` (the one source of truth shared
 * with the stores, the host, and the web); the launcher-specific filters/scripts below key off them.
 */

export { RESERVED_PORTS, type ServiceName, serviceUrl };
export const SERVICE_NAMES = Object.keys(RESERVED_PORTS) as ServiceName[];

/** The pnpm filter that starts each shared service (used by the real platform's startService). */
export const SERVICE_FILTERS: Record<ServiceName, string> = {
  web: "@belay/web",
  blob: "@belay/blob-store",
  store: "@belay/session-store",
  supervisor: "@belay/supervisor",
};

/**
 * The npm script the launcher runs per service. The host-critical stores run NON-watch (`start`)
 * so editing shared/protocol/store source can't restart them out from under a live session and drop
 * its sockets mid-turn - the `pnpm dev` watcher is the place for that, not a `belay`-launched
 * backend. The web stays on `dev` (Vite): its HMR reloads the browser tab, never the host's stream.
 */
export const SERVICE_SCRIPTS: Record<ServiceName, string> = {
  web: "dev",
  blob: "start",
  store: "start",
  // The supervisor is host-critical control plane (it spawns hosts on browser request), so it runs
  // NON-watch (`start`) like the stores - editing launcher/protocol source must not restart it out
  // from under an in-flight launch.
  supervisor: "start",
};

/** The result of probing one reserved port: is something listening, and is it OUR service. */
export interface ServiceProbe {
  readonly reachable: boolean;
  /** True only when the listener identifies as the expected Belay service (not a stranger). */
  readonly ours: boolean;
}

/**
 *  - healthy  : our service is up and answering on its port,
 *  - conflict : the port is taken by some OTHER process (we must not start ours over it),
 *  - down     : nothing is listening (we should start it).
 */
export type ServiceStatus = "healthy" | "conflict" | "down";

export function classifyService(probe: ServiceProbe): ServiceStatus {
  if (!probe.reachable) {
    return "down";
  }
  return probe.ours ? "healthy" : "conflict";
}

export interface ServiceReport {
  readonly name: ServiceName;
  readonly port: number;
  readonly status: ServiceStatus;
}
