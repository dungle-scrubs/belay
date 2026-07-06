import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPAN_NAMES } from "@trevor/session/telemetry";
import { recordingTelemetrySink } from "@trevor/test-kit";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, test } from "vitest";
import type { ProviderRegistry } from "../providers";
import { collectDoctorProbeResults } from "./build";

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
  const results = await collectDoctorProbeResults(providers, { probeTimeoutMs: 20 });
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
