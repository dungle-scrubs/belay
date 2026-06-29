import assert from "node:assert/strict";
import { test } from "vitest";
import { MODEL_METADATA_OVERRIDES, resolveContextWindow } from "./model-metadata-overrides";

/**
 * 02.16 D-003: correctable per-model context-window metadata. The catalog reads each model's window from
 * pi-ai's bundled registry, which can be stale; a confirmed override WINS over it. These pin the
 * resolution rule (override > bundled > null) with an injected overrides map so the production map stays
 * intentionally empty until a stale value is confirmed.
 */

test("the bundled value is used when there is no override (unchanged behavior)", () => {
  assert.equal(resolveContextWindow("MiniMax-M2.7", 204800, {}), 204800);
});

test("a confirmed override wins over the bundled (stale) value", () => {
  // The motivating case: pi-ai declares a model at 512000, but the real window differs.
  const overrides = { "MiniMax-M3": { contextWindow: 1_000_000 } };
  assert.equal(resolveContextWindow("MiniMax-M3", 512000, overrides), 1_000_000);
});

test("an override only applies to its own modelId; others fall through to the bundled value", () => {
  const overrides = { "MiniMax-M3": { contextWindow: 1_000_000 } };
  assert.equal(resolveContextWindow("glm-5.2", 200000, overrides), 200000);
});

test("the window is null when neither an override nor a bundled value is known", () => {
  assert.equal(resolveContextWindow("unknown-model", undefined, {}), null);
});

/**
 * 03.2 M2: MiniMax-M3's bundled window (512000) overstates the real 262144 (session
 * trevor-20260629-033048z-eb100ca0 overflowed at ~412k against the real ceiling), so the production
 * map now carries the confirmed correction and the resolver returns it everywhere the window is read.
 */

test("MiniMax-M3 resolves to its real 262144 window, not the stale bundled 512000", () => {
  assert.equal(resolveContextWindow("MiniMax-M3", 512000), 262144);
});

test("the production override map carries the confirmed MiniMax-M3 correction", () => {
  assert.equal(MODEL_METADATA_OVERRIDES["MiniMax-M3"]?.contextWindow, 262144);
});
