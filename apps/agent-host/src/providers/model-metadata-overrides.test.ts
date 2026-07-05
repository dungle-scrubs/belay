import assert from "node:assert/strict";
import { test } from "vitest";
import {
  loadModelOverridesFile,
  MODEL_METADATA_OVERRIDES,
  parseModelOverrides,
  recordLearnedWindow,
  resolveContextWindow,
} from "./model-metadata-overrides";

/**
 * 02.16 D-003: correctable per-model context-window metadata. The catalog reads each model's window from
 * pi-ai's bundled registry, which can be stale; a confirmed override WINS over it. Corrections are
 * user-owned in `~/.trevor/models.json`; the built-in map is the empty baseline the file layers over.
 * These pin the resolution rule (override > learned > bundled > null) with injected maps + a fake file
 * read, so the resolution is exercised without touching real config or disk.
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
 * Corrections are user-owned: parsed from `~/.trevor/models.json` (parseModelOverrides) and read by
 * loadModelOverridesFile. The motivating case - MiniMax-M3 - is corrected to the model card's 1M in
 * that file, not in code, so the built-in map stays empty.
 */

test("the built-in override map is empty - corrections live in models.json, not code", () => {
  assert.deepEqual(MODEL_METADATA_OVERRIDES, {});
});

test("parseModelOverrides keeps well-formed { contextWindow } entries", () => {
  assert.equal(
    parseModelOverrides({ "MiniMax-M3": { contextWindow: 1_000_000 } })["MiniMax-M3"]
      ?.contextWindow,
    1_000_000,
  );
});

test("parseModelOverrides skips malformed entries but keeps the well-formed rest", () => {
  const parsed = parseModelOverrides({
    "MiniMax-M3": { contextWindow: 1_000_000 },
    "bad-shape": 512000,
    "bad-window-type": { contextWindow: "lots" },
    "non-positive": { contextWindow: 0 },
    infinite: { contextWindow: Number.POSITIVE_INFINITY },
  });
  assert.deepEqual(parsed, { "MiniMax-M3": { contextWindow: 1_000_000 } });
});

test("parseModelOverrides tolerates non-object input", () => {
  assert.deepEqual(parseModelOverrides(null), {});
  assert.deepEqual(parseModelOverrides("nope"), {});
});

test("loadModelOverridesFile reads + parses a present file", () => {
  const overrides = loadModelOverridesFile("/x/models.json", () =>
    JSON.stringify({ "MiniMax-M3": { contextWindow: 1_000_000 } }),
  );
  assert.equal(overrides["MiniMax-M3"]?.contextWindow, 1_000_000);
});

test("loadModelOverridesFile returns {} when the file is missing", () => {
  assert.deepEqual(
    loadModelOverridesFile("/x/models.json", () => {
      throw new Error("ENOENT");
    }),
    {},
  );
});

test("loadModelOverridesFile returns {} on a present-but-malformed file (does not throw)", () => {
  assert.deepEqual(
    loadModelOverridesFile("/x/models.json", () => "{ not valid json"),
    {},
  );
});

test("a models.json correction wins over pi-ai's bundled window through resolveContextWindow", () => {
  const overrides = loadModelOverridesFile("/x/models.json", () =>
    JSON.stringify({ "MiniMax-M3": { contextWindow: 1_000_000 } }),
  );
  assert.equal(resolveContextWindow("MiniMax-M3", 512000, overrides), 1_000_000);
});

/**
 * 03.2 M3: a window LEARNED from a provider's overflow self-heals a stale bundled value on later
 * turns. It is consulted after a static override and before the bundled value, and only ever TIGHTENS:
 * a learned signal can never widen a model past its bundled value or override a static correction.
 */

test("a learned window tightens later resolutions for its model", () => {
  const learned = new Map<string, number>();
  recordLearnedWindow("glm-5.2", 200000, learned);
  assert.equal(resolveContextWindow("glm-5.2", 256000, {}, learned), 200000);
});

test("a learned window never widens past the bundled value", () => {
  const learned = new Map<string, number>();
  recordLearnedWindow("glm-5.2", 600000, learned);
  assert.equal(resolveContextWindow("glm-5.2", 256000, {}, learned), 256000);
});

test("a static override always wins over a learned window", () => {
  const learned = new Map<string, number>();
  recordLearnedWindow("MiniMax-M3", 100000, learned);
  const overrides = { "MiniMax-M3": { contextWindow: 262144 } };
  assert.equal(resolveContextWindow("MiniMax-M3", 512000, overrides, learned), 262144);
});

test("a learned window only tightens monotonically; a later wider signal is ignored", () => {
  const learned = new Map<string, number>();
  recordLearnedWindow("glm-5.2", 200000, learned);
  recordLearnedWindow("glm-5.2", 300000, learned);
  assert.equal(resolveContextWindow("glm-5.2", 512000, {}, learned), 200000);
});
