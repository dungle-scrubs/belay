import assert from "node:assert/strict";
import type { RunningServer } from "@trevor/test-kit";
import { startBlobStore, startSessionStore, testTransport } from "@trevor/test-kit";
import { afterAll, beforeAll, test } from "vitest";

let store: RunningServer;
let blob: RunningServer;

beforeAll(async () => {
  store = await startSessionStore();
  blob = await startBlobStore();
});
afterAll(async () => {
  await store.close();
  await blob.close();
});

test("session-store boots and ensureSession round-trips", async () => {
  const transport = testTransport(store.url);
  assert.equal(await transport.ensureSession("s"), "s");
});

test("blob-store boots and answers /health", async () => {
  const res = await fetch(`${blob.url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
