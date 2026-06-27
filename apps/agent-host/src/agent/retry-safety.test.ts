import assert from "node:assert/strict";
import { test } from "vitest";
import {
  initialRetrySafetyState,
  isSafeToRetry,
  noteProviderEvent,
  noteToolResult,
  outputStarted,
} from "./retry-safety";

test("thinking-only partials are safe to retry and counted separately", () => {
  const state = noteProviderEvent(initialRetrySafetyState(), {
    type: "thinking",
    text: "checking",
  });

  assert.equal(isSafeToRetry(state), true);
  assert.equal(outputStarted(state), false);
  assert.deepEqual(state.partials, {
    textChars: 0,
    thinkingChars: "checking".length,
    toolCalls: 0,
    toolResults: 0,
  });
});

test("visible text, tool calls, and tool results make retry unsafe", () => {
  const text = noteProviderEvent(initialRetrySafetyState(), { type: "text", text: "visible" });
  assert.equal(isSafeToRetry(text), false);
  assert.equal(outputStarted(text), true);

  const toolCall = noteProviderEvent(initialRetrySafetyState(), {
    type: "tool_call",
    call: { id: "c1", name: "bash", arguments: "{}" },
  });
  assert.equal(isSafeToRetry(toolCall), false);

  const toolResult = noteToolResult(initialRetrySafetyState());
  assert.equal(isSafeToRetry(toolResult), false);
});
