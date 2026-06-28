import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createBlobServer } from "@trevor/blob-store/server";
import { type RunningServer, startServer } from "@trevor/server-kit";
import { createSessionStore } from "@trevor/session-store/server";
import { tempDir, testTransport } from "@trevor/test-kit";
import { afterAll, beforeAll, test } from "vitest";

let store: RunningServer;
let blob: RunningServer;
let blobRoot: string;

beforeAll(async () => {
  store = await startServer(createSessionStore(":memory:"), { port: 0 });
  blobRoot = tempDir("trevor-blob-");
  blob = await startServer(createBlobServer(blobRoot, 25 * 1024 * 1024), { port: 0 });
});
afterAll(async () => {
  await store.close();
  await blob.close();
  rmSync(blobRoot, { recursive: true, force: true });
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
