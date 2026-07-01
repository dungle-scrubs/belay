import assert from "node:assert/strict";
import { test } from "vitest";
import { LocalResidencyRegistry } from "./registry";

/**
 * The host-owned Trevor-loaded residency registry (plan 11.1 M2): tracks exactly the local models THIS
 * instance loaded so eviction is gated on Trevor-loaded (D-004). Pure over an injected clock.
 */

const EP = "http://localhost:1234/v1";
const PROVIDER = "lmstudio";

function reg() {
  let t = 1_700_000_000_000;
  return new LocalResidencyRegistry(() => (t += 1_000));
}

test("recordLoad marks a model Trevor-loaded; an untouched model is absent", () => {
  const r = reg();
  r.recordLoad(PROVIDER, EP, "unsloth/qwen3.6-27b-mlx", 65_536);
  assert.equal(r.isTrevorLoaded(EP, "unsloth/qwen3.6-27b-mlx"), true);
  // A model Trevor never loaded (externally loaded / another app) is NOT in the registry.
  assert.equal(
    r.isTrevorLoaded(EP, "qwen/qwen3-vl-8b"),
    false,
    "external model is not Trevor-loaded",
  );
  // The same model id on a DIFFERENT endpoint is a distinct resource.
  assert.equal(r.isTrevorLoaded("http://other:1234/v1", "unsloth/qwen3.6-27b-mlx"), false);

  const resident = r.resident();
  assert.equal(resident.length, 1);
  assert.deepEqual(
    {
      provider: resident[0]?.provider,
      endpoint: resident[0]?.endpoint,
      model: resident[0]?.model,
      contextLength: resident[0]?.contextLength,
    },
    { provider: PROVIDER, endpoint: EP, model: "unsloth/qwen3.6-27b-mlx", contextLength: 65_536 },
  );
});

test("the resident set updates on load and on unload", () => {
  const r = reg();
  r.recordLoad(PROVIDER, EP, "a", 65_536);
  r.recordLoad(PROVIDER, EP, "b", 32_768);
  assert.deepEqual(
    r
      .resident()
      .map((m) => m.model)
      .sort(),
    ["a", "b"],
  );

  r.recordUnload(EP, "a");
  assert.equal(r.isTrevorLoaded(EP, "a"), false, "unload removes it from the set");
  assert.deepEqual(
    r.resident().map((m) => m.model),
    ["b"],
  );

  // Unloading an unknown model is a harmless no-op.
  r.recordUnload(EP, "never");
  assert.equal(r.resident().length, 1);
});

test("recordLoad refreshes a model's context + load time rather than duplicating it", () => {
  const r = reg();
  r.recordLoad(PROVIDER, EP, "a", 32_768);
  const first = r.resident()[0]?.loadedAt;
  r.recordLoad(PROVIDER, EP, "a", 65_536); // reloaded at a bigger window
  assert.equal(r.resident().length, 1, "a reload updates in place, not a second entry");
  assert.equal(r.resident()[0]?.contextLength, 65_536);
  assert.notEqual(r.resident()[0]?.loadedAt, first, "the load time refreshes");
});
