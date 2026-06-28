import assert from "node:assert/strict";
import { test } from "vitest";
import { isContextOverflowText } from "./context-overflow";

test("isContextOverflowText matches web and provider context-window wording", () => {
  for (const detail of [
    "context length exceeded",
    "This model's maximum context is 8192 tokens",
    "token limit reached",
    "too many tokens",
    "reduce the length of the prompt",
    "not enough tokens to keep",
    "model requires a larger context",
    "exceeds the context window",
  ]) {
    assert.equal(isContextOverflowText(detail), true, detail);
  }
});

test("isContextOverflowText rejects unrelated outages and auth failures", () => {
  for (const detail of [
    "ECONNREFUSED: network down",
    "invalid api key",
    "503 service unavailable",
  ]) {
    assert.equal(isContextOverflowText(detail), false, detail);
  }
});
