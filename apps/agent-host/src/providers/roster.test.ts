import assert from "node:assert/strict";
import { test } from "vitest";
import { buildProviders, DEFAULT_PROVIDER, pickProvider } from "./index";
import { DEFAULT_LOCAL_CONTEXT_CAP, lmStudioProvider } from "./lmstudio";

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

test("both local qwen slots load at the bounded default context cap, not the native ceiling (11.1 M1)", () => {
  const providers = buildProviders();
  // The 8-bit slot used to load at native 256k ("model-max"); it now caps at the bounded default,
  // consistent with the 4-bit slot.
  assert.equal(
    providers.qwen?.debugInfo?.().cap,
    DEFAULT_LOCAL_CONTEXT_CAP,
    "8-bit slot is capped",
  );
  assert.equal(
    providers.qwen4bit?.debugInfo?.().cap,
    DEFAULT_LOCAL_CONTEXT_CAP,
    "4-bit slot matches",
  );
});

test("the local context cap stays overridable per-slot and via LMSTUDIO_MAX_CONTEXT (11.1 M1)", () => {
  // A per-slot maxContext wins over the default.
  assert.equal(
    lmStudioProvider({ model: "m", label: "L", maxContext: 32_000 }).debugInfo().cap,
    32_000,
  );

  // LMSTUDIO_MAX_CONTEXT overrides the default for a slot without its own cap.
  const prev = process.env.LMSTUDIO_MAX_CONTEXT;
  process.env.LMSTUDIO_MAX_CONTEXT = "100000";
  try {
    assert.equal(lmStudioProvider({ model: "m", label: "L" }).debugInfo().cap, 100_000);
  } finally {
    if (prev === undefined) {
      delete process.env.LMSTUDIO_MAX_CONTEXT;
    } else {
      process.env.LMSTUDIO_MAX_CONTEXT = prev;
    }
  }
});
