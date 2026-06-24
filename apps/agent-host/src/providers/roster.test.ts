import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROVIDER_MODELS } from "@trevor/session";
import { buildProviders } from "./index";

/**
 * Characterization tests for the shared provider roster (M8 / D-008).
 *
 * The pre-announce roster (provider keys + labels + reasoning options) was spelled in
 * both the host's buildProviders and the web's FALLBACK_MODELS, so adding/renaming a
 * provider meant editing both. These pin the canonical roster and that the host's built
 * providers take their labels from it, so host and the pre-announce UI cannot drift.
 */

test("DEFAULT_PROVIDER_MODELS is the canonical pre-announce roster", () => {
  assert.deepEqual(DEFAULT_PROVIDER_MODELS, {
    qwen: {
      label: "Qwen 27B 8-bit (local)",
      model: "qwen",
      reasoningLevels: ["off", "on"],
      defaultReasoning: "off",
    },
    gpt: {
      label: "GPT-5.5",
      model: "GPT-5.5",
      reasoningLevels: ["minimal", "low", "medium", "high", "xhigh"],
      defaultReasoning: "medium",
    },
    qwen4bit: {
      label: "Qwen 27B 4-bit (local)",
      model: "qwen",
      reasoningLevels: ["off", "on"],
      defaultReasoning: "off",
    },
  });
});

test("the host's built providers take their labels from the shared roster", () => {
  const providers = buildProviders();
  for (const [key, model] of Object.entries(DEFAULT_PROVIDER_MODELS)) {
    assert.equal(providers[key]?.describe().label, model.label);
  }
});
