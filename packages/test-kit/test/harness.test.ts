import assert from "node:assert/strict";
import type { RunningServer } from "@trevor/server-kit";
import { streamTransport } from "@trevor/session";
import { type BootedBlob, bootBlob, bootStore } from "@trevor/test-kit/boot";
import { afterAll, beforeAll, test } from "vitest";

let store: RunningServer;
let blob: BootedBlob;

beforeAll(async () => {
  store = await bootStore();
  blob = await bootBlob();
});
afterAll(async () => {
  await store.close();
  await blob.close();
});

test("session-store boots and ensureSession round-trips", async () => {
  const transport = streamTransport(store.url);
  assert.equal(await transport.ensureSession("s"), "s");
});

test("blob-store boots and answers /health", async () => {
  const res = await fetch(`${blob.url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
