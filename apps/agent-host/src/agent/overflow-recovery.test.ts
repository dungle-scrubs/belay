import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessage } from "../providers";
import { ELISION, trimLargestToolResult } from "./overflow-recovery";

test("trims the largest in-loop tool result, keeping head + tail with a marker", () => {
  const big = "X".repeat(5000);
  const conv: ChatMessage[] = [
    { role: "user", content: "go" },
    { role: "tool", content: "small", toolCallId: "c1", name: "grep" },
    { role: "tool", content: big, toolCallId: "c2", name: "read" },
  ];
  const result = trimLargestToolResult(conv, 0);

  assert.equal(result?.tool, "read");
  assert.ok((result?.reclaimed ?? 0) > 3000, "reclaims most of the 5000 chars");
  const trimmed = conv[2]?.content ?? "";
  assert.ok(trimmed.length < big.length, "the result actually shrank");
  assert.ok(trimmed.includes(ELISION), "carries the elision marker");
  assert.ok(trimmed.startsWith("X"), "keeps the head");
  assert.ok(trimmed.endsWith("X"), "keeps the tail");
  assert.equal(conv[1]?.content, "small", "the smaller result is untouched");
});

test("only trims this turn's results (index >= fromIndex), never prior history", () => {
  const conv: ChatMessage[] = [
    { role: "tool", content: "Y".repeat(5000), toolCallId: "old", name: "read" },
    { role: "user", content: "go" },
    { role: "tool", content: "Z".repeat(3000), toolCallId: "c1", name: "grep" },
  ];
  const result = trimLargestToolResult(conv, 1);

  assert.equal(result?.tool, "grep");
  assert.equal(conv[0]?.content.length, 5000, "prior-history result is left intact");
});

test("returns null when nothing is worth trimming", () => {
  const conv: ChatMessage[] = [
    { role: "user", content: "go" },
    { role: "tool", content: "tiny", toolCallId: "c1", name: "read" },
  ];
  assert.equal(trimLargestToolResult(conv, 0), null);
});

test("does not re-trim an already-trimmed result", () => {
  const conv: ChatMessage[] = [
    { role: "tool", content: "A".repeat(5000), toolCallId: "c1", name: "read" },
  ];
  const first = trimLargestToolResult(conv, 0);
  assert.ok(first);
  const second = trimLargestToolResult(conv, 0);
  assert.equal(second, null, "the marker stops a second pass");
});
