import assert from "node:assert/strict";
import { test } from "vitest";
import { capacityResolver, loadAdmissionConfig, parseAdmissionConfig } from "./config";
import { ADMISSION_DEFAULT_CAPACITY, ADMISSION_STALE_MS } from "./store";

/**
 * Local-admission config (plan 11 M8): the conservative default is capacity 1 per resource; a per-resource
 * or new-default capacity is opt-in only, via `admission.json` or an env override. Pins the tolerant
 * decode, the precedence, and the per-key resolver.
 */

test("an absent / empty config is the conservative default (capacity 1)", () => {
  const config = parseAdmissionConfig(undefined);
  assert.equal(config.defaultCapacity, ADMISSION_DEFAULT_CAPACITY);
  assert.equal(config.staleAfterMs, ADMISSION_STALE_MS);
  assert.deepEqual(config.capacityByResource, {});
  assert.equal(capacityResolver(config)("any-key"), 1, "unconfigured resources stay at capacity 1");
});

test("parseAdmissionConfig keeps well-formed fields and drops garbled ones", () => {
  const config = parseAdmissionConfig({
    defaultCapacity: 3,
    staleAfterMs: 60_000,
    capacityByResource: {
      "local-provider:lmstudio:http://x:1234/v1:big": 4,
      "bad-zero": 0,
      "bad-string": "lots",
    },
  });
  assert.equal(config.defaultCapacity, 3);
  assert.equal(config.staleAfterMs, 60_000);
  assert.deepEqual(config.capacityByResource, {
    "local-provider:lmstudio:http://x:1234/v1:big": 4,
  });
  // A garbled top-level value falls back to the default rather than throwing.
  assert.equal(
    parseAdmissionConfig({ defaultCapacity: -2 }).defaultCapacity,
    ADMISSION_DEFAULT_CAPACITY,
  );
  assert.equal(parseAdmissionConfig("nonsense").defaultCapacity, ADMISSION_DEFAULT_CAPACITY);
});

test("capacityResolver returns the per-resource override, else the default", () => {
  const resolve = capacityResolver(
    parseAdmissionConfig({ defaultCapacity: 2, capacityByResource: { "key-a": 5 } }),
  );
  assert.equal(resolve("key-a"), 5, "the explicit override wins");
  assert.equal(resolve("key-b"), 2, "an unlisted resource uses the default");
});

test("loadAdmissionConfig reads the file and lets an env override win", () => {
  const json = JSON.stringify({ defaultCapacity: 2, staleAfterMs: 30_000 });
  const fromFile = loadAdmissionConfig({ read: () => json });
  assert.equal(fromFile.defaultCapacity, 2);
  assert.equal(fromFile.staleAfterMs, 30_000);

  // An ops env override beats the file.
  const overridden = loadAdmissionConfig({
    read: () => json,
    capacityOverride: 8,
    staleOverride: 90_000,
  });
  assert.equal(overridden.defaultCapacity, 8);
  assert.equal(overridden.staleAfterMs, 90_000);

  // A missing file (read throws) yields the built-in default silently.
  const missing = loadAdmissionConfig({
    read: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(missing.defaultCapacity, ADMISSION_DEFAULT_CAPACITY);
});
