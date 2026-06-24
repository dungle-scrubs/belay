import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../providers";
import { BreakdownAccumulator } from "./breakdown";

test("seedHistory buckets the prior conversation by category", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "hello there" },
    {
      role: "assistant",
      content: "sure",
      toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"a"}' }],
    },
    { role: "tool", content: "file contents here", toolCallId: "c1", name: "read" },
  ];
  const acc = new BreakdownAccumulator(100);
  acc.seedHistory(history);
  const b = acc.snapshot();

  assert.equal(b.input.systemAndTools, 100);
  assert.equal(b.input.userText, "hello there".length);
  assert.equal(b.input.assistantText, "sure".length);
  assert.equal(b.input.toolCallArgs, '{"path":"a"}'.length);
  assert.equal(b.input.toolResults, "file contents here".length);
  assert.equal(b.input.byTool.read, "file contents here".length);
});

test("turn events split into pools; thinking and answer are output-only", () => {
  const acc = new BreakdownAccumulator(0);
  acc.onToolCall('{"q":"x"}'.length);
  acc.onToolResult("grep", 500);
  acc.onThinking(800);
  acc.onAnswer(120);
  const b = acc.snapshot();

  // tool-call args are generated (output) AND fed back into the next step (input)
  assert.equal(b.input.toolCallArgs, '{"q":"x"}'.length);
  assert.equal(b.output.toolCallArgs, '{"q":"x"}'.length);
  // tool results persist only in the input pool
  assert.equal(b.input.toolResults, 500);
  assert.equal(b.input.byTool.grep, 500);
  // thinking + answer are output-only; thinking never enters the input pool
  assert.equal(b.output.thinking, 800);
  assert.equal(b.output.answer, 120);
  assert.equal(b.input.assistantText, 0);
});

test("repeated tool results accumulate per tool name", () => {
  const acc = new BreakdownAccumulator(0);
  acc.onToolResult("read", 10);
  acc.onToolResult("read", 25);
  acc.onToolResult("bash", 7);
  const b = acc.snapshot();

  assert.equal(b.input.byTool.read, 35);
  assert.equal(b.input.byTool.bash, 7);
  assert.equal(b.input.toolResults, 42);
});

test("images are tracked apart from the text categories", () => {
  const acc = new BreakdownAccumulator(0);
  acc.seedHistory([
    {
      role: "user",
      content: "look",
      images: [{ hash: "h", mimeType: "image/png", data: "x".repeat(2048) }],
    },
  ]);
  const b = acc.snapshot();

  assert.equal(b.input.imageCount, 1);
  assert.equal(b.input.imagesBase64, 2048);
  assert.equal(b.input.userText, "look".length);
});

test("snapshot is an independent copy", () => {
  const acc = new BreakdownAccumulator(0);
  acc.onToolResult("read", 10);
  const first = acc.snapshot();
  acc.onToolResult("read", 5);

  assert.equal(first.input.toolResults, 10);
  assert.equal(first.input.byTool.read, 10);
});
