import assert from "node:assert/strict";
import { getModel } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import { toReasoningEffort } from "./pi-ai";

/**
 * `off` must actually turn reasoning OFF (D-062 follow-up). pi-ai's `streamSimple` collapses "off"
 * to an omitted parameter, so a reasoning model falls back to its DEFAULT (medium for GPT-5.5)
 * instead of disabling. We now stream through the lower-level `stream` and compute `reasoningEffort`
 * ourselves: for the Codex Responses API, "off" -> "none" (a documented effort that truly disables);
 * for everything else, "off" -> undefined (those adapters disable on a falsy effort, where "none"
 * would read as enabled). Every other level is clamped to what the model supports.
 */

const codex = getModel("openai-codex", "gpt-5.5");
// A static-key cloud model on the openai-completions API (the other adapter Trevor uses).
const completions = getModel("deepseek", "deepseek-v4-pro");

test("Codex 'off' becomes an explicit 'none' (so reasoning is actually disabled, not defaulted)", () => {
  assert.equal(toReasoningEffort(codex, "off"), "none");
});

test("a non-Codex adapter keeps 'off' as undefined (it disables on a falsy effort)", () => {
  assert.equal(toReasoningEffort(completions, "off"), undefined);
});

test("an absent level stays undefined (use the model default)", () => {
  assert.equal(toReasoningEffort(codex, undefined), undefined);
});

test("a real level is clamped to what the model supports (and passed through)", () => {
  assert.equal(toReasoningEffort(codex, "medium"), "medium");
  assert.equal(toReasoningEffort(codex, "xhigh"), "xhigh");
  // 'minimal' is a supported Codex level here (pi-ai later maps it to low via thinkingLevelMap).
  assert.equal(toReasoningEffort(codex, "minimal"), "minimal");
});
