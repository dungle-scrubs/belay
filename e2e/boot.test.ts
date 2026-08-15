import assert from "node:assert/strict";
import type { RunningServer } from "@belay/server-kit";
import { streamTransport } from "@belay/session";
import { type BootedBlob, bootBlob, bootStore } from "@belay/test-kit/boot";
import { afterAll, beforeAll, test } from "vitest";

/**
 * S-BOOT: the backing services come up together on ephemeral ports and answer. The first
 * gate - if this fails, nothing above it in the stack can be trusted, so the e2e lane runs
 * it first (serial, by config).
 */

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

test("session-store binds a port and ensureSession round-trips", async () => {
  assert.equal(await streamTransport(store.url).ensureSession("boot"), "boot");
});

test("blob-store binds a port and answers /health", async () => {
  const res = await fetch(`${blob.url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
