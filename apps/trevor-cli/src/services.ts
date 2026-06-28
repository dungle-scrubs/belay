import { RESERVED_PORTS, type ServiceName } from "@trevor/session/ports";

/**
 * Shared-service readiness for the launcher (D-085). The web UI, blob store, and session-store are
 * shared local services (one set across all projects, on reserved loopback ports) - the launcher
 * checks them before starting a project host, starts any that are missing, and flags a reserved port
 * that some OTHER process has taken. The classification is pure over an injected probe result; the
 * actual HTTP probing lives in the platform.
 *
 * The reserved ports themselves are owned by `@trevor/session/ports` (the one source of truth shared
 * with the stores, the host, and the web); the launcher-specific filters/scripts below key off them.
 */

export { RESERVED_PORTS, type ServiceName };
export const SERVICE_NAMES = Object.keys(RESERVED_PORTS) as ServiceName[];

/** The pnpm filter that starts each shared service (used by the real platform's startService). */
export const SERVICE_FILTERS: Record<ServiceName, string> = {
  web: "@trevor/web",
  blob: "@trevor/blob-store",
  store: "@trevor/session-store",
};

/**
 * The npm script the launcher runs per service. The host-critical stores run NON-watch (`start`)
 * so editing shared/protocol/store source can't restart them out from under a live session and drop
 * its sockets mid-turn - the `pnpm dev` watcher is the place for that, not a `trevor`-launched
 * backend. The web stays on `dev` (Vite): its HMR reloads the browser tab, never the host's stream.
 */
export const SERVICE_SCRIPTS: Record<ServiceName, string> = {
  web: "dev",
  blob: "start",
  store: "start",
};

/** The result of probing one reserved port: is something listening, and is it OUR service. */
export interface ServiceProbe {
  readonly reachable: boolean;
  /** True only when the listener identifies as the expected Trevor service (not a stranger). */
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

/** Classifies every reserved service from its probe. */
export function classifyServices(probes: Record<ServiceName, ServiceProbe>): ServiceReport[] {
  return SERVICE_NAMES.map((name) => ({
    name,
    port: RESERVED_PORTS[name],
    status: classifyService(probes[name]),
  }));
}

/** The services that must be started (nothing listening). */
export const missingServices = (reports: readonly ServiceReport[]): ServiceReport[] =>
  reports.filter((r) => r.status === "down");

/** The reserved ports a foreign process is squatting (a conflict the launcher reports, never starts over). */
export const conflictingServices = (reports: readonly ServiceReport[]): ServiceReport[] =>
  reports.filter((r) => r.status === "conflict");
