import assert from "node:assert/strict";
import { test } from "vitest";
import { buildSourceProvider } from "./catalog";

/**
 * D-065 turn resolution: buildSourceProvider builds a Provider for an arbitrary `{sourceId, modelId}`
 * from a known catalog source, so ANY catalog model runs (not just the registered keys). An unknown
 * source returns null, so the caller falls back to the legacy registered providers.
 */

test("builds a per-model provider for each known source type", () => {
  const zai = buildSourceProvider("zai", "glm-5.1");
  assert.equal(zai?.kind, "cloud");
  assert.equal(zai?.id, "zai");
  assert.equal(zai?.model, "glm-5.1");

  const openai = buildSourceProvider("openai", "gpt-5.5");
  assert.equal(openai?.kind, "cloud");
  assert.equal(openai?.model, "gpt-5.5");

  const local = buildSourceProvider("lmstudio", "qwen/qwen3-vl-8b");
  assert.equal(local?.kind, "local");
  assert.equal(local?.model, "qwen/qwen3-vl-8b");
});

test("an unknown source returns null (caller falls back to the registered providers)", () => {
  assert.equal(buildSourceProvider("nope", "whatever"), null);
});
