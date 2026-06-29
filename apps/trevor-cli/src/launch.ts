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
  classifyService,
  RESERVED_PORTS,
  SERVICE_NAMES,
  type ServiceName,
  type ServiceProbe,
  type ServiceReport,
  serviceUrl,
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

/** Live progress sink the orchestrator drives through each phase (a spinner in the real CLI, a no-op
 *  in tests), so `trevor` gives immediate feedback during the several seconds of startup. */
export interface Reporter {
  step(text: string): void;
}

export interface LaunchPlatform {
  readonly fs: LauncherFs;
  readonly home: string;
  readonly cwd: string;
  /** This launcher process's pid (for the lock owner). */
  readonly pid: number;
  readonly reporter: Reporter;
  now(): string;
  processAlive(pid: number): boolean;
  probeService(name: ServiceName, port: number): Promise<ServiceProbe>;
  startService(name: ServiceName): Promise<void>;
  /** Resolves once the session-store is accepting connections (or false on timeout). */
  waitForStore(): Promise<boolean>;
  /** Resolves once the web UI (Vite dev server) is serving, so the browser tab isn't opened against
   *  a port that's still booting (or false on timeout). */
  waitForWeb(): Promise<boolean>;
  /** True when a live host is already answering this session. */
  hostPresent(sessionId: string): Promise<boolean>;
  spawnHost(opts: { sessionId: string; root: string; debug?: boolean }): Promise<SpawnedHost>;
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
  /** Whether the web UI was serving by the time we opened the tab (false = opened anyway, reload). */
  readonly webReady: boolean;
}

/** The web UI URL for a session (the single place the `?session=` handoff URL is built). */
export function sessionUrl(sessionId: string): string {
  return `${serviceUrl("web")}/?session=${sessionId}`;
}

export async function launch(
  platform: LaunchPlatform,
  options: {
    readonly debug?: boolean;
    /** `trevor open <session>` (D-094 M3): launch this exact session at its root, instead of
     *  resolving the session from the current project directory. */
    readonly session?: { readonly sessionId: string; readonly root: string };
  } = {},
): Promise<LaunchOutcome> {
  platform.reporter.step("resolving project…");
  const root = options.session?.root ?? resolveProjectRoot(platform.cwd, platform.fs);
  const sessionId =
    options.session?.sessionId ?? resolveSession(platform.fs, platform.home, root, platform.now());
  const url = sessionUrl(sessionId);

  // 1. Shared services: probe the reserved ports, start the missing ones (never one set per project),
  //    surface conflicts, and wait for the store before touching the host.
  platform.reporter.step("checking shared services…");
  const services: ServiceReport[] = [];
  const conflicts: ServiceReport[] = [];
  const startedServices: ServiceName[] = [];
  for (const name of SERVICE_NAMES) {
    const port = RESERVED_PORTS[name];
    const status = classifyService(await platform.probeService(name, port));
    const report: ServiceReport = { name, port, status };
    services.push(report);
    if (status === "conflict") {
      conflicts.push(report);
    } else if (status === "down") {
      platform.reporter.step(`starting ${name}…`);
      await platform.startService(name);
      startedServices.push(name);
    }
  }
  platform.reporter.step("waiting for session store…");
  await platform.waitForStore();

  // 2. Host lifecycle behind the per-session lock, so two concurrent launches can't both spawn.
  const lock = acquireLock(platform.fs, platform.home, sessionId, {
    pid: platform.pid,
    now: platform.now(),
    processAlive: platform.processAlive,
  });
  if (!lock.acquired) {
    // A concurrent launch owns this session and is spawning; just wait for it and open the tab.
    platform.reporter.step("waiting for host…");
    const online = await platform.waitForHostOnline(sessionId);
    platform.reporter.step("waiting for web UI…");
    const webReady = await platform.waitForWeb();
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
      webReady,
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
      platform.reporter.step("reusing agent host…");
      hostPid = record.pid;
    } else {
      if (hostAction === "replace-stale") {
        removeHost(platform.fs, platform.home, sessionId);
      }
      platform.reporter.step("starting agent host…");
      const spawned = await platform.spawnHost({ sessionId, root, debug: options.debug });
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

  if (hostAction !== "reuse") {
    platform.reporter.step("waiting for host to join…");
  }
  const online = hostAction === "reuse" ? true : await platform.waitForHostOnline(sessionId);
  // Wait for the web UI to actually serve before opening the tab, so a freshly-started Vite dev
  // server (a few seconds to boot) doesn't greet the user with ERR_CONNECTION_REFUSED.
  platform.reporter.step("waiting for web UI…");
  const webReady = await platform.waitForWeb();
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
    webReady,
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
    `open     ${outcome.url}${outcome.webReady ? "" : " · web still starting, reload if it doesn't load"}`,
  ];
  if (outcome.conflicts.length > 0) {
    lines.push(
      `⚠ port conflict: ${outcome.conflicts.map((c) => `${c.name} (${c.port})`).join(", ")} - another process owns this reserved port`,
    );
  }
  return lines.join("\n");
}
