import assert from "node:assert/strict";
import type { ModelRef } from "@trevor/session";
import { test } from "vitest";
import { controlPromptModel } from "./control-model";

const glm: ModelRef = { sourceId: "zai", modelId: "glm-5.2", reasoning: "xhigh" };
const deepseek: ModelRef = { sourceId: "deepseek", modelId: "deepseek-chat", reasoning: null };

test("returns the most recent turn's catalog model so a continuation stays on it", () => {
  // newest is last; the most recent model-bearing turn wins
  assert.deepEqual(controlPromptModel([{ model: deepseek }, { model: glm }]), glm);
});

test("looks past model-less control prompts back to the last real selection", () => {
  // the user picked glm-5.2, then host-issued control prompts carried no model (the bug);
  // the resume should still land on glm-5.2, not the default provider
  assert.deepEqual(controlPromptModel([{ model: glm }, {}, {}]), glm);
});

test("returns undefined for a legacy provider-string-only session", () => {
  assert.equal(controlPromptModel([{}, {}]), undefined);
  assert.equal(controlPromptModel([]), undefined);
});
