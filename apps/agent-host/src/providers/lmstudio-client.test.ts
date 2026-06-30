import assert from "node:assert/strict";
import { test } from "vitest";
import { LmStudioClient } from "./lmstudio-client";

/**
 * Characterization tests for the LM Studio load lifecycle (M5 / D-008). They pin the /doctor-facing
 * debugInfo() shape and the best-effort unreachable path - hermetically, by pointing the client at
 * a dead port so fetch fails fast (no LM Studio required). The dedup + reload-from-CLI paths need a
 * live server and are exercised by the live-model e2e lane, not here.
 */

function deadClient(contextCap = Number.POSITIVE_INFINITY): LmStudioClient {
  return new LmStudioClient({
    // Port 1 is never an LM Studio server, so fetch rejects immediately (connection refused).
    url: "http://127.0.0.1:1/v1",
    model: "test/model",
    contextCap,
    visionOverride: null,
    lmsBin: "lms",
    providerId: "lmstudio",
  });
}

test("debugInfo starts empty: nothing served, no reload, no error", () => {
  const info = deadClient().debugInfo();
  assert.deepEqual(info, {
    served: null,
    cap: "model-max",
    reloading: false,
    lifecycleReload: false,
    lastReloadMs: null,
    lastError: null,
    lastErrorClass: null,
  });
});

test("debugInfo renders a finite context cap as the number", () => {
  assert.equal(deadClient(65536).debugInfo().cap, 65536);
});

test("readiness against an unreachable server is not ready and not warm", async () => {
  assert.deepEqual(await deadClient().probe(), { ready: false, warm: false });
});

test("capabilities against an unreachable server falls back to the assumed defaults", async () => {
  // No model record learned: tools default true, no vision, native ceiling unknown (0).
  assert.deepEqual(await deadClient().capabilities(), {
    images: false,
    tools: true,
    contextLength: 0,
  });
});

test("ensureMaxContext on an unreachable server serves the fallback window and records the error", async () => {
  const client = deadClient();
  const served = await client.ensureMaxContext();
  assert.equal(served, 8192, "the assumed fallback window is served when LM Studio is unreachable");
  const info = client.debugInfo();
  // The fallback is returned but NOT persisted as the served window (contextWindow stays unset),
  // so /doctor still shows nothing reliably served - the original behavior, preserved.
  assert.equal(info.served, null);
  assert.equal(info.reloading, false, "the in-flight load is cleared after it resolves");
  assert.match(String(info.lastError), /LM Studio not reachable/);
  // The last failure is surfaced WITH its normalized taxonomy class (D-076 M6): a local runtime
  // that isn't reachable, not a generic outage.
  assert.equal(info.lastErrorClass, "local_runtime_unavailable");
});

test("buildModel sizes the pi-ai model to the served window and the configured base URL", () => {
  const model = deadClient().buildModel(65536);
  assert.equal(model.contextWindow, 65536);
  assert.equal(model.maxTokens, 65536);
  assert.equal(model.baseUrl, "http://127.0.0.1:1/v1");
  assert.equal(model.api, "openai-completions");
  assert.deepEqual(model.input, ["text"]);
});

test("a vision override forces image input on the built model", () => {
  const client = new LmStudioClient({
    url: "http://127.0.0.1:1/v1",
    model: "test/model",
    contextCap: Number.POSITIVE_INFINITY,
    visionOverride: true,
    lmsBin: "lms",
    providerId: "lmstudio",
  });
  assert.deepEqual(client.buildModel(4096).input, ["text", "image"]);
  assert.equal(client.visionEnabled, true);
});
