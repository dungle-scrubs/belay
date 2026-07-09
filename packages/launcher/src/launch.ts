import {
  NOOP_SINK,
  redactAttributeValue,
  SPAN_NAMES,
  safeAttributes,
  safeEmitSpan,
  type TelemetrySink,
} from "@trevor/session/telemetry";
import type { LauncherFs } from "./fs";
import {
  acquireLock,
  decideHostAction,
  type HostAction,
  loadHosts,
  reapDeadHosts,
  recordHost,
  releaseLock,
  removeHost,
} from "./host-registry";
import { resolveProjectRoot, resolveSession } from "./project";
import { touchProject } from "./project-registry";
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
  /** The config home (TREVOR_HOME) for home-abbreviation in the project registry displayPath. */
  readonly configHome: string;
  readonly cwd: string;
  /** This launcher process's pid (for the lock owner). */
  readonly pid: number;
  readonly reporter: Reporter;
  /** Telemetry sink for the launch span (plan 13 M4); NOOP (disabled) unless an exporter is wired. The
   *  span carries only debug + host action + counts, never paths, session ids, or URLs. */
  readonly telemetry?: TelemetrySink;
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

/** Launches (or attaches to) a session, wrapped in a `trevor.cli.launch` span: the span times the whole
 *  lifecycle and records the host action + started-service count + online outcome (no paths / session
 *  ids / URLs). Delegates to {@link launchInner}, which owns the actual orchestration. */
export async function launch(
  platform: LaunchPlatform,
  options: {
    readonly debug?: boolean;
    readonly noBrowser?: boolean;
    readonly session?: { readonly sessionId: string; readonly root: string };
  } = {},
): Promise<LaunchOutcome> {
  const sink = platform.telemetry ?? NOOP_SINK;
  const startedAt = Date.now();
  try {
    const outcome = await launchInner(platform, options);
    emitLaunchSpan(sink, "ok", Date.now() - startedAt, {
      host_action: outcome.hostAction,
      started_services: outcome.startedServices.length,
      online: outcome.online,
    });
    return outcome;
  } catch (error) {
    emitLaunchSpan(sink, "error", Date.now() - startedAt, { debug: options.debug ?? false }, error);
    throw error;
  }
}

/** Records the launch span, best-effort (a telemetry failure must never fail a launch). */
function emitLaunchSpan(
  sink: TelemetrySink,
  status: "ok" | "error",
  durationMs: number,
  attributes: Readonly<Record<string, unknown>>,
  error?: unknown,
): void {
  safeEmitSpan(sink, {
    name: SPAN_NAMES.cliLaunch,
    attributes: safeAttributes(attributes),
    status,
    durationMs,
    ...(error
      ? { error: redactAttributeValue(error instanceof Error ? error.message : String(error)) }
      : {}),
  });
}

async function launchInner(
  platform: LaunchPlatform,
  options: {
    readonly debug?: boolean;
    /** True for headless callers that need services + host readiness without opening the web UI. */
    readonly noBrowser?: boolean;
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

  // Touch the project registry (plan 58 M8): so the launched project appears in the sidebar's project
  // list without waiting for a live host. Best-effort: a registry write failure must never block a
  // launch (the host can still start; the sidebar just won't show the project until the next touch).
  try {
    touchProject(platform.fs, platform.home, root, platform.now(), platform.configHome);
  } catch {
    // Swallow: registry persistence is a UI-side concern, not a launch gate.
  }

  // 1. Shared services: probe the reserved ports, start the missing ones (never one set per project),
  //    surface conflicts, and wait for the store before touching the host.
  platform.reporter.step("checking shared services…");
  const services: ServiceReport[] = [];
  const conflicts: ServiceReport[] = [];
  const startedServices: ServiceName[] = [];
  // Probe every reserved port at once (each is an independent HTTP round-trip up to ~800ms);
  // the start decision below still runs in SERVICE_NAMES order so the output is unchanged.
  const reports = await Promise.all(
    SERVICE_NAMES.map(async (name): Promise<ServiceReport> => {
      const port = RESERVED_PORTS[name];
      const status = classifyService(await platform.probeService(name, port));
      return { name, port, status };
    }),
  );
  for (const report of reports) {
    services.push(report);
    if (report.status === "conflict") {
      conflicts.push(report);
    } else if (report.status === "down") {
      platform.reporter.step(`starting ${report.name}…`);
      await platform.startService(report.name);
      startedServices.push(report.name);
    }
  }
  platform.reporter.step("waiting for session store…");
  await platform.waitForStore();

  // 2. Host lifecycle behind the per-session lock, so two concurrent launches can't both spawn.
  //    First sweep the whole registry: a host that died without a clean shutdown (SIGKILL, machine
  //    restart) leaves a stale record that otherwise lingers until a launch targets THAT session, so
  //    hosts.json would keep reporting a dead host as "running". Cheap (kill(pid,0) per record) and a
  //    no-op write when nothing is dead.
  const reaped = reapDeadHosts(platform.fs, platform.home, platform.processAlive);
  if (reaped.length > 0) {
    platform.reporter.step(`reaped ${reaped.length} stale host record(s)…`);
  }
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
    if (!options.noBrowser) {
      await platform.openBrowser(url);
    }
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
  if (!options.noBrowser) {
    await platform.openBrowser(url);
  }
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
