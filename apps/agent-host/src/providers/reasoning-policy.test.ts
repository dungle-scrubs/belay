import assert from "node:assert/strict";
import { getModel } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import {
  isGradedReasoningModel,
  reasoningEffortFor,
  reasoningStreamFields,
} from "./reasoning-policy";

/**
 * `off` must actually turn reasoning OFF (D-062 follow-up). pi-ai's `streamSimple` collapses "off" to
 * an omitted parameter, so a graded-effort model falls back to its DEFAULT (medium for GPT-5.5)
 * instead of disabling. We stream through the lower-level `stream` and compute `reasoningEffort` here,
 * keyed on the model's ADAPTER (`model.api`): a graded Responses-family adapter gets an explicit
 * "none" (documented, truly disables); every other adapter disables on a FALSY effort, so "off" stays
 * undefined there (where "none" would read as enabled). Every real level is clamped to what the model
 * supports.
 */

// gpt-5.5 -> api "openai-codex-responses": the graded Responses family.
const graded = getModel("openai-codex", "gpt-5.5");
// deepseek -> api "openai-completions": a toggle adapter (disables on a falsy effort).
const toggle = getModel("deepseek", "deepseek-v4-pro");

test("the Responses-family adapter is classified graded; openai-completions is not", () => {
  assert.equal(isGradedReasoningModel(graded), true);
  assert.equal(isGradedReasoningModel(toggle), false);
});

test("a graded model's 'off' becomes an explicit 'none' (reasoning actually disabled, not defaulted)", () => {
  assert.equal(reasoningEffortFor(graded, "off"), "none");
});

test("a toggle adapter keeps 'off' as undefined (it disables on a falsy effort)", () => {
  assert.equal(reasoningEffortFor(toggle, "off"), undefined);
});

test("an absent level stays undefined (use the model default)", () => {
  assert.equal(reasoningEffortFor(graded, undefined), undefined);
});

test("a real level is clamped to what the model supports (and passed through)", () => {
  assert.equal(reasoningEffortFor(graded, "medium"), "medium");
  assert.equal(reasoningEffortFor(graded, "xhigh"), "xhigh");
  // 'minimal' is a supported Codex level here (pi-ai later maps it to low via thinkingLevelMap).
  assert.equal(reasoningEffortFor(graded, "minimal"), "minimal");
});

/**
 * The fields that reach the wire. pi-ai.ts spreads these straight into stream()'s options, so this
 * is where the OMIT matters: a defined effort must appear as a key; an undefined one must be ABSENT,
 * not present-as-undefined (which a toggle adapter would read as a falsy-but-present effort).
 */
test("a defined effort is present as a key", () => {
  assert.deepEqual(reasoningStreamFields(graded, "off"), { reasoningEffort: "none" });
  assert.deepEqual(reasoningStreamFields(graded, "medium"), { reasoningEffort: "medium" });
});

test("an omitted effort leaves reasoningEffort OFF the object entirely (not present-as-undefined)", () => {
  const toggleOff = reasoningStreamFields(toggle, "off");
  assert.deepEqual(toggleOff, {});
  assert.equal("reasoningEffort" in toggleOff, false);

  const noLevel = reasoningStreamFields(graded, undefined);
  assert.deepEqual(noLevel, {});
  assert.equal("reasoningEffort" in noLevel, false);
});
