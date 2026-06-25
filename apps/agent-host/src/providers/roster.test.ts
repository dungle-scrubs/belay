import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProviders, DEFAULT_PROVIDER } from "./index";

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
