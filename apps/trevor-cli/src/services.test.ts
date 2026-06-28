import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyService, SERVICE_NAMES, SERVICE_SCRIPTS } from "./services";

/**
 * Shared-service readiness classification (D-085 M2): healthy vs conflict vs down, and the derived
 * "must start" / "port conflict" sets. Pure over injected probe results - no sockets.
 */

test("classifyService maps a probe to healthy / conflict / down", () => {
  assert.equal(classifyService({ reachable: true, ours: true }), "healthy");
  assert.equal(classifyService({ reachable: true, ours: false }), "conflict");
  assert.equal(classifyService({ reachable: false, ours: false }), "down");
});

test("SERVICE_NAMES preserves reserved service startup order", () => {
  assert.deepEqual(SERVICE_NAMES, ["web", "blob", "store"]);
});

test("the host-critical stores run non-watch (start); the web stays on dev (Vite HMR)", () => {
  // A `trevor`-launched backend must not restart the store/blob out from under a live session
  // when shared/protocol source is edited - only `pnpm dev` watches. The web's HMR is host-safe.
  assert.equal(SERVICE_SCRIPTS.store, "start");
  assert.equal(SERVICE_SCRIPTS.blob, "start");
  assert.equal(SERVICE_SCRIPTS.web, "dev");
});
