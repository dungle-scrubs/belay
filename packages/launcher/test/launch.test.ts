import assert from "node:assert/strict";
import { SPAN_NAMES, type TelemetrySink } from "@trevor/session/telemetry";
import { recordingTelemetrySink } from "@trevor/test-kit";
import { test } from "vitest";
import type { LauncherFs } from "../src/fs";
import { recordHost } from "../src/host-registry";
import { formatStatus, type LaunchPlatform, launch, sessionUrl } from "../src/launch";
import { resolveSession } from "../src/project";
import { loadProjectRegistry } from "../src/project-registry";
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
  configHome?: string;
  pid?: number;
  probes?: Partial<Record<ServiceName, ServiceProbe>>;
  processAlive?: (pid: number) => boolean;
  hostPresent?: boolean;
  lockHeldByLive?: number; // a concurrent live launcher already holding the session lock
  telemetry?: TelemetrySink;
}

interface Spy {
  platform: LaunchPlatform;
  started: ServiceName[];
  spawned: { sessionId: string; root: string; debug?: boolean }[];
  opened: string[];
}

function makePlatform(opts: FakeOpts = {}): Spy {
  const fs = opts.fs ?? fakeFs();
  // Mark the git root present so resolveProjectRoot finds it.
  if (opts.gitRoot) {
    fs.writeFile(`${opts.gitRoot}/.git`, "");
  }
  const started: ServiceName[] = [];
  const spawned: { sessionId: string; root: string; debug?: boolean }[] = [];
  const opened: string[] = [];
  let spawnPid = 9000;
  const platform: LaunchPlatform = {
    fs,
    home: "/home/.trevor",
    configHome: opts.configHome ?? "/home/.trevor",
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
    spawnHost: ({ sessionId, root, debug }) => {
      spawned.push({ sessionId, root, ...(debug ? { debug } : {}) });
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
    ...(opts.telemetry ? { telemetry: opts.telemetry } : {}),
  };
  // Pre-seat a concurrent live lock holder if requested.
  if (opts.lockHeldByLive) {
    const root = opts.gitRoot ?? "/work/app";
    const sessionId = resolveSession(fs, "/home/.trevor", root, "t");
    fs.writeFile(
      `/home/.trevor/locks/${sessionId}.lock`,
      JSON.stringify({ pid: opts.lockHeldByLive, acquiredAt: "t" }),
    );
  }
  return { platform, started, spawned, opened };
}

test("a launch emits a trevor.cli.launch span with host action + counts, no paths/session ids/urls", async () => {
  const recorder = recordingTelemetrySink();
  const spy = makePlatform({
    gitRoot: "/work/app",
    telemetry: recorder.sink,
    probes: {
      web: { reachable: true, ours: true },
      blob: { reachable: false, ours: false },
      store: { reachable: false, ours: false },
    },
  });
  const outcome = await launch(spy.platform);

  const [span] = recorder.named(SPAN_NAMES.cliLaunch);
  assert.ok(span, "a launch span was recorded");
  assert.equal(span?.status, "ok");
  assert.equal(span?.attributes.host_action, outcome.hostAction);
  assert.equal(span?.attributes.started_services, outcome.startedServices.length);
  assert.equal(span?.attributes.online, outcome.online);
  const serialized = JSON.stringify(span);
  assert.ok(!serialized.includes(outcome.sessionId), "the session id never enters the span");
  assert.ok(!serialized.includes("/work/app"), "the project path never enters the span");
  assert.ok(!serialized.includes(outcome.url), "the session URL never enters the span");
});

test("a launch failure records an error launch span and rethrows", async () => {
  const recorder = recordingTelemetrySink();
  const spy = makePlatform({ gitRoot: "/work/app", telemetry: recorder.sink });
  // Force a failure deep in the lifecycle: waitForStore rejects.
  const platform: LaunchPlatform = {
    ...spy.platform,
    waitForStore: () => Promise.reject(new Error("store never came up")),
  };
  await assert.rejects(launch(platform), /store never came up/);
  const [span] = recorder.named(SPAN_NAMES.cliLaunch);
  assert.equal(span?.status, "error");
  assert.ok(span?.error?.includes("store never came up"));
});

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
  // Only the down services were started; the healthy web was left alone. blob + store + supervisor
  // (plan 44.1) all probed down here, so all three start.
  assert.deepEqual(spy.started.sort(), ["blob", "store", "supervisor"]);
  // The host was spawned with the resolved session + project root (cwd resolved up to the git root).
  assert.deepEqual(spy.spawned, [{ sessionId: outcome.sessionId, root: "/work/app" }]);
  // The browser opened the reserved web port with the session query.
  assert.deepEqual(spy.opened, [sessionUrl(outcome.sessionId)]);
  assert.equal(outcome.url, `http://127.0.0.1:${RESERVED_PORTS.web}/?session=${outcome.sessionId}`);
  assert.equal(outcome.online, true);
});

test("noBrowser launches services and host without opening a browser", async () => {
  const spy = makePlatform({
    gitRoot: "/work/app",
    cwd: "/work/app/src/deep",
    probes: {
      web: { reachable: true, ours: true },
      blob: { reachable: false, ours: false },
      store: { reachable: false, ours: false },
    },
  });
  const outcome = await launch(spy.platform, { noBrowser: true });

  assert.equal(outcome.root, "/work/app");
  assert.equal(outcome.hostAction, "spawn");
  assert.deepEqual(spy.spawned, [{ sessionId: outcome.sessionId, root: "/work/app" }]);
  assert.deepEqual(spy.opened, []);
});

test("noBrowser also suppresses browser open while waiting on a concurrent launcher", async () => {
  const spy = makePlatform({
    gitRoot: "/work/app",
    cwd: "/work/app",
    probes: {
      web: { reachable: true, ours: true },
      blob: { reachable: true, ours: true },
      store: { reachable: true, ours: true },
    },
    lockHeldByLive: 777,
    processAlive: (pid) => pid === 777,
  });
  const outcome = await launch(spy.platform, { noBrowser: true });

  assert.equal(outcome.hostAction, "reused-concurrent");
  assert.deepEqual(spy.spawned, []);
  assert.deepEqual(spy.opened, []);
});

test("--debug threads the debug flag through to the spawned host", async () => {
  const spy = makePlatform({ gitRoot: "/work/app" });
  const outcome = await launch(spy.platform, { debug: true });
  // The host is spawned with debug:true (the no-debug case is covered above: no debug key).
  assert.deepEqual(spy.spawned, [{ sessionId: outcome.sessionId, root: "/work/app", debug: true }]);
});

test("a healthy recorded host is reused, not re-spawned", async () => {
  const fs = fakeFs();
  fs.writeFile("/work/app/.git", "");
  const sessionId = resolveSession(fs, "/home/.trevor", "/work/app", "t");
  recordHost(fs, "/home/.trevor", {
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
      // The supervisor (plan 44.1) is already up too: an ensured service that is healthy is reused,
      // not restarted.
      supervisor: { reachable: true, ours: true },
    },
    processAlive: (pid) => pid === 5555, // the recorded host is alive
    hostPresent: true,
  });
  const outcome = await launch(spy.platform);
  assert.equal(outcome.hostAction, "reuse");
  assert.equal(outcome.hostPid, 5555);
  assert.deepEqual(spy.spawned, []); // nothing re-spawned
  assert.deepEqual(spy.started, []); // every shared service (supervisor included) was already up
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

test("a launch touches the project registry so the launched project appears in the sidebar (M8)", async () => {
  const spy = makePlatform({ gitRoot: "/work/app", cwd: "/work/app/src" });
  const outcome = await launch(spy.platform);

  // The registry now has a record for the resolved project root, with a displayName (basename) and
  // a non-empty updatedAt. This is the wiring that keeps the sidebar's project list current without
  // relying on a live host.
  const registry = loadProjectRegistry(spy.platform.fs, spy.platform.home);
  const record = registry.get(outcome.root);
  assert.ok(record, "the launched project root was added to the registry");
  assert.equal(record?.path, "/work/app");
  assert.equal(record?.displayName, "app");
  assert.ok(record?.updatedAt.length === "2026-06-26T00:00:00Z".length);
});

test("a launch with an explicit session touches the registry for that session's root (M8)", async () => {
  const spy = makePlatform({ gitRoot: "/work/app" });
  const outcome = await launch(spy.platform, {
    session: { sessionId: "explicit-id", root: "/work/app" },
  });
  const registry = loadProjectRegistry(spy.platform.fs, spy.platform.home);
  assert.ok(registry.has(outcome.root), "the explicit-session root was registered");
  assert.equal(registry.get("/work/app")?.displayName, "app");
});

test("repeated launches for the same root do not duplicate the registry record (M8)", async () => {
  const spy = makePlatform({ gitRoot: "/work/app" });
  await launch(spy.platform);
  await launch(spy.platform);
  const registry = loadProjectRegistry(spy.platform.fs, spy.platform.home);
  assert.equal(registry.size, 1, "one record, not two");
  assert.ok(registry.has("/work/app"));
});
