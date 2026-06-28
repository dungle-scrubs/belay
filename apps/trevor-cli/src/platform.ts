import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeTrevorEvent, type SessionEvent, streamTransport } from "@trevor/session";
import { raceTimeout } from "@trevor/session/async";
import { nodeFs } from "./fs";
import type { LaunchPlatform, Reporter, SpawnedHost } from "./launch";
import { TREVOR_HOME } from "./project";
import {
  RESERVED_PORTS,
  SERVICE_FILTERS,
  SERVICE_SCRIPTS,
  type ServiceName,
  type ServiceProbe,
} from "./services";

/**
 * The real, node-backed launcher platform: HTTP probes of the reserved ports, spawning shared
 * services + the project host, watching the session stream for `host.online`, and opening the browser.
 * All the actual I/O the orchestrator (launch.ts) treats as injected capabilities lives here, so the
 * orchestration stays pure and testable and this module is the only place with side effects.
 */

const STORE_URL = `http://127.0.0.1:${RESERVED_PORTS.store}`;
const WEB_URL = `http://127.0.0.1:${RESERVED_PORTS.web}/`;
const PROBE_TIMEOUT_MS = 800;
const STORE_READY_TIMEOUT_MS = 15_000;
// Vite cold-starts can take several seconds (deps optimize), so the web gets a more generous window.
const WEB_READY_TIMEOUT_MS = 30_000;
const HOST_ONLINE_TIMEOUT_MS = 20_000;
const HOST_PRESENT_TIMEOUT_MS = 1_500;

export interface HostSpawnCommand {
  readonly args: readonly string[];
  readonly command: string;
  readonly file: string;
}

/** The monorepo root (nearest ancestor of this file holding pnpm-workspace.yaml). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return process.cwd();
    }
    dir = parent;
  }
}

/** A timed GET that degrades any failure (network error or timeout-abort) to null, so a probe reads
 *  as "not listening" rather than throwing. The abort+timer protocol lives in `raceTimeout`. */
function fetchWithTimeout(url: string, ms: number): Promise<Response | null> {
  return raceTimeout((signal) => fetch(url, { signal }), ms).catch(() => null);
}

/** Probes one reserved port. store/blob expose `GET /health -> {ok:true}` (our identity); the web
 *  (a Vite dev server) has no health route, so any response on its port reads as ours. */
async function probeService(name: ServiceName, port: number): Promise<ServiceProbe> {
  if (name === "web") {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/`, PROBE_TIMEOUT_MS);
    return { reachable: res !== null, ours: res !== null };
  }
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/health`, PROBE_TIMEOUT_MS);
  if (!res) {
    return { reachable: false, ours: false };
  }
  // A 200 with `{ ok: true }` is our service; any other listener on the reserved port is a conflict.
  try {
    const body = (await res.json()) as { ok?: unknown };
    return { reachable: true, ours: res.ok && body?.ok === true };
  } catch {
    return { reachable: true, ours: false };
  }
}

/**
 * Opens (append) a log file under `<TREVOR_HOME>/logs/<name>.log` and returns its fd, so a detached
 * child's stdout/stderr is captured instead of discarded - the launcher spawns everything detached,
 * and without this a crash or a stalled stream leaves NO trace (the stuck-turn diagnosis had to read
 * the SQLite event log directly). Falls back to "ignore" if the log can't be opened.
 */
function logFd(name: string): number | "ignore" {
  try {
    mkdirSync(join(TREVOR_HOME, "logs"), { recursive: true });
    return openSync(join(TREVOR_HOME, "logs", `${name}.log`), "a");
  } catch {
    return "ignore";
  }
}

/** Spawns a shared service detached through the repo's pnpm runner, so it outlives this launcher
 *  and only one set exists across projects. Its output goes to `<TREVOR_HOME>/logs/<name>.log`. */
function startService(name: ServiceName): Promise<void> {
  const out = logFd(name);
  const child = spawn("pnpm", ["--filter", SERVICE_FILTERS[name], SERVICE_SCRIPTS[name]], {
    cwd: repoRoot(),
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return Promise.resolve();
}

/** Polls a URL until it answers (or the timeout elapses). `accept` decides what counts as ready. */
async function pollUntil(
  url: string,
  timeoutMs: number,
  accept: (res: Response) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(url, PROBE_TIMEOUT_MS);
    if (res && accept(res)) {
      return true;
    }
    await delay(300);
  }
  return false;
}

/** Polls the store's `/health` until ready or the timeout elapses. */
function waitForStore(): Promise<boolean> {
  return pollUntil(`${STORE_URL}/health`, STORE_READY_TIMEOUT_MS, (res) => res.ok);
}

/** Polls the web dev server until it serves a response (any status = the port is live and answering). */
function waitForWeb(): Promise<boolean> {
  return pollUntil(WEB_URL, WEB_READY_TIMEOUT_MS, () => true);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Watches a session's stream for `host.online` (or presence), resolving true on the first sighting and
 * false at the timeout. Reuses the same `@trevor/session` transport the host + web speak, so the
 * "host joined" evidence is the real wire event, not a guess.
 */
function watchSession(
  sessionId: string,
  timeoutMs: number,
  satisfied: (event: SessionEvent) => boolean,
): Promise<boolean> {
  return new Promise((resolveOnce) => {
    const transport = streamTransport(STORE_URL);
    let done = false;
    const connection = transport.connectSession({
      sessionId,
      identity: {
        displayName: "trevor-launcher",
        runtimeKind: "web",
        instanceId: `launcher-${process.pid}`,
        participantId: `launcher-${process.pid}`,
      },
      onEvent: (event) => {
        if (!done && satisfied(event)) {
          finish(true);
        }
      },
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(value: boolean): void {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      try {
        connection.close();
      } catch {
        // already closed
      }
      resolveOnce(value);
    }
  });
}

const isHostOnline = (event: SessionEvent): boolean =>
  decodeTrevorEvent(event)?.type === "host.online";

export function buildHostSpawnCommand(opts: {
  readonly envFileExists: boolean;
  readonly envFile: string;
  readonly hostMain: string;
  readonly nodePath: string;
  readonly tsxCli: string;
}): HostSpawnCommand {
  if (!opts.envFileExists) {
    return {
      args: [opts.tsxCli, opts.hostMain],
      command: "tsx agent-host",
      file: opts.nodePath,
    };
  }
  return {
    args: [
      "primary",
      "--read",
      "op",
      "run",
      `--env-file=${opts.envFile}`,
      "--",
      opts.nodePath,
      opts.tsxCli,
      opts.hostMain,
    ],
    command: "opchain primary --read op run --env-file=<TREVOR_HOME>/.env.op -- tsx agent-host",
    file: "opchain",
  };
}

async function spawnHost(opts: {
  sessionId: string;
  root: string;
  debug?: boolean;
}): Promise<SpawnedHost> {
  // Run the host through tsx with cwd = the project root, so its host-cwd tools (read/write/bash)
  // operate in the project and confined tools see TREVOR_WORKSPACE. Env is inherited (so a shell that
  // already injected provider secrets passes them through) plus the session + workspace; nothing
  // secret is constructed or logged here.
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  const hostMain = join(repoRoot(), "apps", "agent-host", "src", "main.ts");
  const envFile = join(TREVOR_HOME, ".env.op");
  const command = buildHostSpawnCommand({
    envFile,
    envFileExists: existsSync(envFile),
    hostMain,
    nodePath: process.execPath,
    tsxCli,
  });
  // Capture the host's logs per session (it's detached, so its output would otherwise vanish).
  const out = logFd(`host-${opts.sessionId}`);
  const child: ChildProcess = spawn(command.file, command.args, {
    cwd: opts.root,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      SESSION_ID: opts.sessionId,
      TREVOR_WORKSPACE: opts.root,
      TREVOR_MANAGED_HOST: "1",
      // Debug mode (`trevor --debug`): the host boots with its debug command surface on (incl.
      // /restart). The flag rides the env so it survives the host's own /restart re-exec.
      ...(opts.debug ? { TREVOR_DEBUG: "1" } : {}),
    },
  });
  child.unref();
  return { pid: child.pid ?? -1, command: `${command.command} (SESSION_ID=${opts.sessionId})` };
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.unref();
  } catch {
    // Opening is best-effort; the URL is always printed in the status line.
  }
}

/** Builds the real launcher platform bound to this process + the local filesystem. The `reporter`
 *  drives the live progress spinner (a no-op by default, so the platform is usable without one). */
export function nodePlatform(reporter: Reporter = { step: () => {} }): LaunchPlatform {
  return {
    fs: nodeFs,
    home: TREVOR_HOME,
    cwd: process.cwd(),
    pid: process.pid,
    reporter,
    now: () => new Date().toISOString(),
    processAlive: (pid) => {
      if (pid <= 0) {
        return false;
      }
      try {
        process.kill(pid, 0); // signal 0 = liveness probe, never actually kills
        return true;
      } catch {
        return false;
      }
    },
    probeService,
    startService,
    waitForStore,
    waitForWeb,
    hostPresent: (sessionId) => watchSession(sessionId, HOST_PRESENT_TIMEOUT_MS, isHostOnline),
    spawnHost,
    waitForHostOnline: (sessionId) => watchSession(sessionId, HOST_ONLINE_TIMEOUT_MS, isHostOnline),
    openBrowser,
  };
}
