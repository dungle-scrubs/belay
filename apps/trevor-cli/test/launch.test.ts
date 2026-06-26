import assert from "node:assert/strict";
import { test } from "vitest";
import type { LauncherFs } from "../src/fs";
import { recordHost } from "../src/host-registry";
import { formatStatus, type LaunchPlatform, launch, sessionUrl } from "../src/launch";
import { resolveSession } from "../src/project";
import { RESERVED_PORTS, type ServiceName, type ServiceProbe } from "../src/services";

/**
 * The launcher orchestration end-to-end against a FAKE platform (no real services, processes, or
 * browser): it proves the launcher derives + opens the expected session URL, starts only the missing
 * services, spawns the host with the right session + workspace, reuses a healthy host instead of
 * re-spawning, defers to a concurrent lock holder, and prints a secret-free status line. This is the
 * "boots fake services" integration lane from the plan, hermetic and deterministic.
 */

function fakeFs(): LauncherFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content) => void files.set(path, content),
    exists: (path) => files.has(path),
    remove: (path) => void files.delete(path),
  };
}

interface FakeOpts {
  fs?: LauncherFs;
  cwd?: string;
  gitRoot?: string; // a `.git` marker the fs should report present
  pid?: number;
  probes?: Partial<Record<ServiceName, ServiceProbe>>;
  processAlive?: (pid: number) => boolean;
  hostPresent?: boolean;
  lockHeldByLive?: number; // a concurrent live launcher already holding the session lock
}

interface Spy {
  platform: LaunchPlatform;
  started: ServiceName[];
  spawned: { sessionId: string; root: string }[];
  opened: string[];
}

function makePlatform(opts: FakeOpts = {}): Spy {
  const fs = opts.fs ?? fakeFs();
  // Mark the git root present so resolveProjectRoot finds it.
  if (opts.gitRoot) {
    fs.writeFile(`${opts.gitRoot}/.git`, "");
  }
  const started: ServiceName[] = [];
  const spawned: { sessionId: string; root: string }[] = [];
  const opened: string[] = [];
  let spawnPid = 9000;
  const platform: LaunchPlatform = {
    fs,
    home: "/home/.trevorV2",
    cwd: opts.cwd ?? opts.gitRoot ?? "/work/app",
    pid: opts.pid ?? 1234,
    reporter: { step: () => {} },
    now: () => "2026-06-26T00:00:00Z",
    processAlive: opts.processAlive ?? (() => true),
    probeService: (name) =>
      Promise.resolve(opts.probes?.[name] ?? { reachable: false, ours: false }),
    startService: (name) => {
      started.push(name);
      return Promise.resolve();
    },
    waitForStore: () => Promise.resolve(true),
    waitForWeb: () => Promise.resolve(true),
    hostPresent: () => Promise.resolve(opts.hostPresent ?? false),
    spawnHost: ({ sessionId, root }) => {
      spawned.push({ sessionId, root });
      spawnPid += 1;
      return Promise.resolve({
        pid: spawnPid,
        command: `tsx agent-host (SESSION_ID=${sessionId})`,
      });
    },
    waitForHostOnline: () => Promise.resolve(true),
    openBrowser: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
  };
  // Pre-seat a concurrent live lock holder if requested.
  if (opts.lockHeldByLive) {
    const root = opts.gitRoot ?? "/work/app";
    const sessionId = resolveSession(fs, "/home/.trevorV2", root, "t");
    fs.writeFile(
      `/home/.trevorV2/locks/${sessionId}.lock`,
      JSON.stringify({ pid: opts.lockHeldByLive, acquiredAt: "t" }),
    );
  }
  return { platform, started, spawned, opened };
}

test("a fresh launch starts missing services, spawns the host, and opens the session URL", async () => {
  const spy = makePlatform({
    gitRoot: "/work/app",
    cwd: "/work/app/src/deep",
    probes: {
      web: { reachable: true, ours: true }, // already up
      blob: { reachable: false, ours: false }, // must start
      store: { reachable: false, ours: false }, // must start
    },
  });
  const outcome = await launch(spy.platform);

  assert.equal(outcome.root, "/work/app");
  assert.equal(outcome.hostAction, "spawn");
  // Only the down services were started; the healthy web was left alone.
  assert.deepEqual(spy.started.sort(), ["blob", "store"]);
  // The host was spawned with the resolved session + project root (cwd resolved up to the git root).
  assert.deepEqual(spy.spawned, [{ sessionId: outcome.sessionId, root: "/work/app" }]);
  // The browser opened the reserved web port with the session query.
  assert.deepEqual(spy.opened, [sessionUrl(outcome.sessionId)]);
  assert.equal(outcome.url, `http://127.0.0.1:${RESERVED_PORTS.web}/?session=${outcome.sessionId}`);
  assert.equal(outcome.online, true);
});

test("a healthy recorded host is reused, not re-spawned", async () => {
  const fs = fakeFs();
  fs.writeFile("/work/app/.git", "");
  const sessionId = resolveSession(fs, "/home/.trevorV2", "/work/app", "t");
  recordHost(fs, "/home/.trevorV2", {
    sessionId,
    pid: 5555,
    root: "/work/app",
    command: "tsx agent-host",
    startedAt: "t",
  });
  const spy = makePlatform({
    fs,
    cwd: "/work/app",
    probes: {
      web: { reachable: true, ours: true },
      blob: { reachable: true, ours: true },
      store: { reachable: true, ours: true },
    },
    processAlive: (pid) => pid === 5555, // the recorded host is alive
    hostPresent: true,
  });
  const outcome = await launch(spy.platform);
  assert.equal(outcome.hostAction, "reuse");
  assert.equal(outcome.hostPid, 5555);
  assert.deepEqual(spy.spawned, []); // nothing re-spawned
  assert.deepEqual(spy.opened, [sessionUrl(sessionId)]);
});

test("a concurrent live lock holder defers spawning (reused-concurrent), still opening the tab", async () => {
  const spy = makePlatform({
    gitRoot: "/work/app",
    cwd: "/work/app",
    probes: {
      web: { reachable: true, ours: true },
      blob: { reachable: true, ours: true },
      store: { reachable: true, ours: true },
    },
    lockHeldByLive: 777,
    processAlive: (pid) => pid === 777, // the other launcher is alive
  });
  const outcome = await launch(spy.platform);
  assert.equal(outcome.hostAction, "reused-concurrent");
  assert.deepEqual(spy.spawned, []); // we did NOT spawn a duplicate
  assert.equal(spy.opened.length, 1);
});

test("the status line reports the handoff and never leaks secret-bearing values", async () => {
  const spy = makePlatform({
    gitRoot: "/work/secret-proj",
    cwd: "/work/secret-proj",
    probes: {
      web: { reachable: true, ours: true },
      blob: { reachable: false, ours: false },
      store: { reachable: true, ours: false }, // a conflict
    },
  });
  // Seed a provider-secret-looking value into the launcher's own env to prove it's never echoed.
  process.env.OPENAI_API_KEY = "sk-should-never-appear-in-status";
  const status = formatStatus(await launch(spy.platform));
  process.env.OPENAI_API_KEY = undefined;

  assert.match(status, /session {2}/);
  assert.match(status, /project {2}\/work\/secret-proj/);
  assert.match(status, /open {5}http:\/\/127\.0\.0\.1/);
  assert.match(status, /port conflict/); // the store conflict is surfaced
  assert.equal(status.includes("sk-should-never-appear-in-status"), false);
  assert.equal(status.toLowerCase().includes("api_key"), false);
});
