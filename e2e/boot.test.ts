import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createBlobServer } from "@trevor/blob-store/server";
import { type RunningServer, startServer } from "@trevor/server-kit";
import { createSessionStore } from "@trevor/session-store/server";
import { tempDir, testTransport } from "@trevor/test-kit";
import { afterAll, beforeAll, test } from "vitest";

/**
 * S-BOOT: the backing services come up together on ephemeral ports and answer. The first
 * gate - if this fails, nothing above it in the stack can be trusted, so the e2e lane runs
 * it first (serial, by config).
 */

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

test("session-store binds a port and ensureSession round-trips", async () => {
  assert.equal(await testTransport(store.url).ensureSession("boot"), "boot");
});

test("blob-store binds a port and answers /health", async () => {
  const res = await fetch(`${blob.url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
