import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPAN_NAMES } from "@trevor/session/telemetry";
import { recordingTelemetrySink } from "@trevor/test-kit";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, test } from "vitest";
import type { ProviderRegistry } from "../providers";
import { storageArea } from "./areas-platform";
import { collectDoctorProbeResults } from "./build";
import type { DoctorProbeInput } from "./probe-input";

/**
 * Plan 41 M4: `/doctor` provider probing is BOUNDED and NON-MUTATING. These drive the real command
 * probe path (`collectDoctorProbeResults`) - not the standalone runner - and pin two guarantees:
 *  1. a wedged provider readiness degrades to `unreachable` within the injected timeout instead of
 *     hanging the whole command, and
 *  2. a health probe only reads `readiness()`; it never warms, loads, or streams a model, so running
 *     /doctor can never change provider/model state.
 */

let stateHome: string;
const savedStateHome = process.env.TREVOR_STATE_HOME;

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), "trevor-doctor-build-"));
  process.env.TREVOR_STATE_HOME = stateHome;
});

afterEach(() => {
  if (savedStateHome === undefined) {
    delete process.env.TREVOR_STATE_HOME;
  } else {
    process.env.TREVOR_STATE_HOME = savedStateHome;
  }
  rmSync(stateHome, { recursive: true, force: true });
});

/** A provider whose readiness is `readiness`, and whose mutating surfaces (`warm`, `stream`) throw if
 *  a health probe ever touches them - so a call proves /doctor mutated provider state. */
function provider(over: {
  readonly kind: "local" | "cloud";
  readonly readiness: () => ReturnType<ProviderRegistry[string]["readiness"]>;
  readonly onMutate: () => void;
}): ProviderRegistry[string] {
  return {
    id: "p",
    label: "P",
    model: "m",
    reasoningLevels: [],
    defaultReasoning: "off",
    kind: over.kind,
    describe: () => ({
      label: "P",
      model: "m",
      reasoningLevels: [],
      defaultReasoning: "off",
      kind: over.kind,
    }),
    readiness: over.readiness,
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 8192 }),
    warm: () => {
      over.onMutate();
      return Effect.void;
    },
    stream: () => {
      over.onMutate();
      return Stream.empty;
    },
  } as unknown as ProviderRegistry[string];
}

async function startDiagServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ readonly close: () => Promise<void>; readonly url: string }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a wedged provider readiness degrades to unreachable within the injected timeout, not a hang", async () => {
  const providers = {
    // Readiness never settles; with a 20ms probe budget it must still resolve as unreachable.
    hung: provider({
      kind: "cloud",
      readiness: () => Effect.never as ReturnType<ProviderRegistry[string]["readiness"]>,
      onMutate: () => assert.fail("a health probe must never warm/stream a provider"),
    }),
  } as unknown as ProviderRegistry;

  const start = Date.now();
  const results = await collectDoctorProbeResults(providers, {
    hostSha: null,
    probeTimeoutMs: 20,
    storeDiagTimeoutMs: 20,
    storeDiagUrl: "http://127.0.0.1:1",
  });
  const elapsed = Date.now() - start;

  assert.equal(
    results.providers[0]?.status,
    "unreachable",
    "a timed-out readiness reads unreachable",
  );
  assert.ok(elapsed < 2000, "the bounded probe returns well before the default 2s budget");
});

test("running /doctor probes never warm, load, or stream a provider (non-mutating)", async () => {
  let mutated = false;
  const providers = {
    warm: provider({
      kind: "local",
      readiness: () => Effect.succeed({ ready: true, warm: true }),
      onMutate: () => {
        mutated = true;
      },
    }),
    cold: provider({
      kind: "cloud",
      readiness: () => Effect.succeed({ ready: true, warm: false }),
      onMutate: () => {
        mutated = true;
      },
    }),
  } as unknown as ProviderRegistry;

  const results = await collectDoctorProbeResults(providers);
  assert.equal(mutated, false, "no probe touched a mutating provider surface");
  assert.deepEqual(
    results.providers.map((p) => p.status).sort(),
    ["cold", "warm"],
    "readiness alone drives the warm/cold verdict",
  );
});

test("collectDoctorProbeResults decodes session-store /diag and emits a store diag span", async () => {
  const recorder = recordingTelemetrySink();
  const diagServer = await startDiagServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        indexHealthy: false,
        queries: 8,
        schemaVersion: 1,
        slowQueries: 2,
        startupSha: "store-sha",
      }),
    );
  });
  try {
    const results = await collectDoctorProbeResults({} as ProviderRegistry, {
      hostSha: "host-sha",
      probeTimeoutMs: 20,
      storeDiagTimeoutMs: 100,
      storeDiagUrl: diagServer.url,
      telemetry: recorder.sink,
    });

    assert.equal(results.storeDiag.kind, "ok");
    assert.equal(results.storeDiag.hostSha, "host-sha");
    assert.equal(results.storeDiag.kind === "ok" && results.storeDiag.diag.indexHealthy, false);
    const span = recorder.named(SPAN_NAMES.storeDiag)[0];
    assert.equal(span?.status, "ok");
    assert.equal(span?.attributes.index_healthy, false);
    assert.equal(span?.attributes.schema_version, 1);
  } finally {
    await diagServer.close();
  }
});

test("collectDoctorProbeResults degrades a hung session-store /diag probe to unknown", async () => {
  const diagServer = await startDiagServer(() => {
    // Leave the request open; the injected AbortController timeout must bound the doctor probe.
  });
  try {
    const start = Date.now();
    const results = await collectDoctorProbeResults({} as ProviderRegistry, {
      hostSha: "host-sha",
      probeTimeoutMs: 20,
      storeDiagTimeoutMs: 20,
      storeDiagUrl: diagServer.url,
    });
    const elapsed = Date.now() - start;

    assert.equal(results.storeDiag.kind, "unknown");
    assert.ok(elapsed < 1000, "the bounded store diag probe returns quickly");
  } finally {
    await diagServer.close();
  }
});

test("a stalled /diag BODY also degrades to unknown within the budget (the abort covers the body read)", async () => {
  const diagServer = await startDiagServer((_req, res) => {
    // Headers + a partial body, then the stream stalls forever: the timeout must bound the WHOLE
    // exchange, not just the header phase, or the doctor's Promise.all never returns.
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"indexHealthy":true,');
  });
  try {
    const start = Date.now();
    const results = await collectDoctorProbeResults({} as ProviderRegistry, {
      hostSha: "host-sha",
      probeTimeoutMs: 20,
      storeDiagTimeoutMs: 30,
      storeDiagUrl: diagServer.url,
    });
    const elapsed = Date.now() - start;

    assert.equal(results.storeDiag.kind, "unknown");
    assert.ok(elapsed < 1000, "a stalled body is aborted by the same budget as stalled headers");
  } finally {
    await diagServer.close();
  }
});

test("a host cwd outside the trevor repo never yields a spurious store code-drift finding", async () => {
  // The trevor checkout's HEAD - the sha the host CODE actually runs from (this test file lives in it).
  const trevorHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    encoding: "utf8",
  }).trim();

  // A different git repo with its own distinct HEAD, standing in for the USER'S PROJECT root the
  // launcher spawns the host into (cwd = project root, not the trevor checkout).
  const projectDir = mkdtempSync(join(tmpdir(), "trevor-project-"));
  const savedCwd = process.cwd();
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (args: readonly string[]) =>
    execFileSync("git", [...args], { cwd: projectDir, encoding: "utf8", env: gitEnv }).trim();
  const diagServer = await startDiagServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        indexHealthy: true,
        queries: 1,
        schemaVersion: 1,
        slowQueries: 0,
        // The store reports the SAME trevor HEAD: healthy, zero drift.
        startupSha: trevorHead,
      }),
    );
  });
  try {
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "x"]);
    const projectHead = git(["rev-parse", "HEAD"]);
    assert.notEqual(projectHead, trevorHead, "the project repo genuinely has a different HEAD");
    process.chdir(projectDir);

    // No injected hostSha: the REAL resolution path runs, from a cwd that is not the trevor repo.
    const results = await collectDoctorProbeResults({} as ProviderRegistry, {
      storeDiagTimeoutMs: 1000,
      storeDiagUrl: diagServer.url,
    });
    assert.equal(results.storeDiag.kind, "ok");
    assert.equal(
      results.storeDiag.hostSha,
      trevorHead,
      "the host sha comes from the trevor checkout the code runs from, never process.cwd()",
    );

    const area = storageArea({
      storage: { roots: [], store: results.storeDiag },
    } as unknown as DoctorProbeInput);
    assert.ok(
      !(area.findings ?? []).some((f) => f.id === "storage.store.sha"),
      "no bogus session-store code-drift finding for a session opened outside the trevor repo",
    );
  } finally {
    process.chdir(savedCwd);
    await diagServer.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});
