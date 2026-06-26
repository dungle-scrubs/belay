import type { LauncherFs } from "./fs";
import {
  acquireLock,
  decideHostAction,
  type HostAction,
  loadHosts,
  recordHost,
  releaseLock,
  removeHost,
} from "./host-registry";
import { resolveProjectRoot, resolveSession } from "./project";
import {
  classifyServices,
  conflictingServices,
  missingServices,
  RESERVED_PORTS,
  SERVICE_NAMES,
  type ServiceName,
  type ServiceProbe,
  type ServiceReport,
} from "./services";

/**
 * The launcher orchestrator (D-085): resolve the project + session, ready the shared services, take
 * the per-session lock, reuse-or-spawn the project host, then hand off to the browser. Pure over an
 * injected `LaunchPlatform` (all I/O - probing, spawning, opening - is a capability), so the whole
 * flow is integration-tested with fakes and the real wiring lives only in `main.ts`.
 */

export interface SpawnedHost {
  readonly pid: number;
  readonly command: string;
}

export interface LaunchPlatform {
  readonly fs: LauncherFs;
  readonly home: string;
  readonly cwd: string;
  /** This launcher process's pid (for the lock owner). */
  readonly pid: number;
  now(): string;
  processAlive(pid: number): boolean;
  probeService(name: ServiceName, port: number): Promise<ServiceProbe>;
  startService(name: ServiceName): Promise<void>;
  /** Resolves once the session-store is accepting connections (or false on timeout). */
  waitForStore(): Promise<boolean>;
  /** True when a live host is already answering this session. */
  hostPresent(sessionId: string): Promise<boolean>;
  spawnHost(opts: { sessionId: string; root: string }): Promise<SpawnedHost>;
  /** Resolves true once the spawned host announces it joined the session (or false on timeout). */
  waitForHostOnline(sessionId: string): Promise<boolean>;
  openBrowser(url: string): Promise<void>;
}

export interface LaunchOutcome {
  readonly root: string;
  readonly sessionId: string;
  readonly url: string;
  readonly services: readonly ServiceReport[];
  readonly startedServices: readonly ServiceName[];
  readonly conflicts: readonly ServiceReport[];
  /** "reused-concurrent" = another `trevor` held the lock and is spawning; we just opened the tab. */
  readonly hostAction: HostAction | "reused-concurrent";
  readonly hostPid: number | null;
  readonly online: boolean;
}

/** The web UI URL for a session (the single place the `?session=` handoff URL is built). */
export function sessionUrl(sessionId: string): string {
  return `http://127.0.0.1:${RESERVED_PORTS.web}/?session=${sessionId}`;
}

export async function launch(platform: LaunchPlatform): Promise<LaunchOutcome> {
  const root = resolveProjectRoot(platform.cwd, platform.fs);
  const sessionId = resolveSession(platform.fs, platform.home, root, platform.now());
  const url = sessionUrl(sessionId);

  // 1. Shared services: probe the reserved ports, start the missing ones (never one set per project),
  //    surface conflicts, and wait for the store before touching the host.
  const probes = {} as Record<ServiceName, ServiceProbe>;
  for (const name of SERVICE_NAMES) {
    probes[name] = await platform.probeService(name, RESERVED_PORTS[name]);
  }
  const services = classifyServices(probes);
  const conflicts = conflictingServices(services);
  const startedServices: ServiceName[] = [];
  for (const report of missingServices(services)) {
    await platform.startService(report.name);
    startedServices.push(report.name);
  }
  await platform.waitForStore();

  // 2. Host lifecycle behind the per-session lock, so two concurrent launches can't both spawn.
  const lock = acquireLock(platform.fs, platform.home, sessionId, {
    pid: platform.pid,
    now: platform.now(),
    processAlive: platform.processAlive,
  });
  if (!lock.acquired) {
    // A concurrent launch owns this session and is spawning; just wait for it and open the tab.
    const online = await platform.waitForHostOnline(sessionId);
    await platform.openBrowser(url);
    return {
      root,
      sessionId,
      url,
      services,
      startedServices,
      conflicts,
      hostAction: "reused-concurrent",
      hostPid: null,
      online,
    };
  }

  let hostAction: HostAction;
  let hostPid: number | null = null;
  try {
    const record = loadHosts(platform.fs, platform.home)[sessionId] ?? null;
    const present = record ? await platform.hostPresent(sessionId) : false;
    hostAction = decideHostAction(record, {
      processAlive: platform.processAlive,
      hostPresent: present,
    });
    if (hostAction === "reuse" && record) {
      hostPid = record.pid;
    } else {
      if (hostAction === "replace-stale") {
        removeHost(platform.fs, platform.home, sessionId);
      }
      const spawned = await platform.spawnHost({ sessionId, root });
      hostPid = spawned.pid;
      recordHost(platform.fs, platform.home, {
        sessionId,
        pid: spawned.pid,
        root,
        command: spawned.command,
        startedAt: platform.now(),
      });
    }
  } finally {
    releaseLock(platform.fs, platform.home, sessionId, platform.pid);
  }

  const online = hostAction === "reuse" ? true : await platform.waitForHostOnline(sessionId);
  await platform.openBrowser(url);
  return {
    root,
    sessionId,
    url,
    services,
    startedServices,
    conflicts,
    hostAction,
    hostPid,
    online,
  };
}

/**
 * The concise, secret-free status line (D-085 M4). Reports session id, project root, which services
 * were reused vs started, host reused vs spawned, and the URL - and NOTHING from the environment (no
 * `.env.op`, provider keys, OAuth material, or expanded secret-bearing values ever pass through here).
 */
export function formatStatus(outcome: LaunchOutcome): string {
  const startedSet = new Set(outcome.startedServices);
  const servicesLine = outcome.services
    .map((s) => `${s.name}:${startedSet.has(s.name) ? "started" : s.status}`)
    .join(" ");
  const hostLine =
    outcome.hostAction === "reuse"
      ? `reused (pid ${outcome.hostPid})`
      : outcome.hostAction === "reused-concurrent"
        ? "reused (concurrent launch)"
        : `spawned (pid ${outcome.hostPid})`;
  const lines = [
    `session  ${outcome.sessionId}`,
    `project  ${outcome.root}`,
    `services ${servicesLine}`,
    `host     ${hostLine}${outcome.online ? "" : " · waiting for host…"}`,
    `open     ${outcome.url}`,
  ];
  if (outcome.conflicts.length > 0) {
    lines.push(
      `⚠ port conflict: ${outcome.conflicts.map((c) => `${c.name} (${c.port})`).join(", ")} - another process owns this reserved port`,
    );
  }
  return lines.join("\n");
}
