import assert from "node:assert/strict";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { test } from "vitest";
import {
  explicitOffEffortFor,
  reasoningEffortFor,
  reasoningStreamFields,
} from "./reasoning-policy";

/**
 * `off` must actually turn reasoning OFF (D-062 follow-up). pi-ai's `streamSimple` collapses "off" to
 * an omitted parameter, so a graded-effort model falls back to its DEFAULT (medium for GPT-5.5)
 * instead of disabling. We stream through the lower-level `stream` and compute `reasoningEffort` here.
 * The off value comes from the model descriptor's `thinkingLevelMap.off` when present; toggle-style
 * adapters omit it and disable on a falsy effort, so "off" stays undefined there. Codex Responses is
 * pinned as a temporary descriptor-gap fallback until its model entry carries `off: "none"`.
 */

// gpt-5.5 -> api "openai-codex-responses": the graded Responses family.
const graded = getBuiltinModel("openai-codex", "gpt-5.5");
// gpt-5.2 -> api "openai-responses": its descriptor carries off -> none directly.
const descriptorOff = getBuiltinModel("openai", "gpt-5.2");
// deepseek -> api "openai-completions": a toggle adapter (disables on a falsy effort).
const toggle = getBuiltinModel("deepseek", "deepseek-v4-pro");
// Claude adaptive thinking uses a different option surface; off still means omit reasoningEffort.
const anthropic = getBuiltinModel("anthropic", "claude-opus-4-7");

test("explicit off comes from the descriptor when available", () => {
  assert.equal(explicitOffEffortFor(descriptorOff), "none");
});

test("Codex's descriptor gap falls back to explicit 'none'", () => {
  assert.equal(explicitOffEffortFor(graded), "none");
  assert.equal(reasoningEffortFor(graded, "off"), "none");
});

test("toggle and non-reasoningEffort adapters keep 'off' undefined", () => {
  assert.equal(reasoningEffortFor(toggle, "off"), undefined);
  assert.equal(reasoningEffortFor(anthropic, "off"), undefined);
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
