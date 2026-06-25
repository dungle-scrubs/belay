import assert from "node:assert/strict";
import { test } from "vitest";
import { buildProviders, DEFAULT_PROVIDER, pickProvider } from "./index";

/**
 * Characterization test for the host's provider roster.
 *
 * The host is the single source of the announced roster (host.online): the provider keys
 * and their curated display labels live ONLY in buildProviders, and each adapter
 * auto-detects its reasoning options (pi-ai registry / LM Studio) - nothing is duplicated
 * in a shared package. This pins the keys + labels so a rename/removal is a deliberate
 * edit, and that the default provider key resolves to a built provider.
 */

const EXPECTED_LABELS: Record<string, string> = {
  qwen: "Qwen 27B 8-bit (local)",
  gpt: "GPT-5.5",
  qwen4bit: "Qwen 27B 4-bit (local)",
  deepseek: "DeepSeek V4 Pro",
  glm: "GLM-5.2 (Z.ai)",
  minimax: "MiniMax M2.7",
};

test("buildProviders exposes the canonical provider keys and labels", () => {
  const providers = buildProviders();
  assert.deepEqual(Object.keys(providers).sort(), Object.keys(EXPECTED_LABELS).sort());
  for (const [key, label] of Object.entries(EXPECTED_LABELS)) {
    assert.equal(providers[key]?.describe().label, label);
  }
});

test("the default provider key resolves to a built provider", () => {
  assert.ok(buildProviders()[DEFAULT_PROVIDER]);
});

test("pickProvider resolves a known key and falls back to the default for an unknown one", () => {
  const providers = buildProviders();
  assert.equal(pickProvider(providers, "glm").describe().label, EXPECTED_LABELS.glm);
  // Unknown key and a missing/non-string key both fall back to the default (qwen).
  assert.equal(pickProvider(providers, "nonexistent").describe().label, EXPECTED_LABELS.qwen);
  assert.equal(pickProvider(providers, undefined).describe().label, EXPECTED_LABELS.qwen);
});
