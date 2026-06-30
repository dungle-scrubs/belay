import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessage } from "../providers";
import { normalizeConversationForProvider } from "./cross-model";

/**
 * Plan 09.1 M6: the cross-provider normalization boundary. A carried conversation must replay on a
 * DIFFERENT provider, so provider-specific tool-call/tool-result id encodings are re-id'd to a neutral
 * scheme (pairing preserved) and inlined assistant thinking-block signatures are stripped.
 */

test("re-ids provider-specific tool ids to a neutral scheme, preserving assistant<->result pairing", () => {
  const conversation: ChatMessage[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "calling tools",
      toolCalls: [
        { id: "toolu_01ABC", name: "read", arguments: "{}" },
        { id: "toolu_02XYZ", name: "bash", arguments: "{}" },
      ],
    },
    { role: "tool", content: "r1", toolCallId: "toolu_01ABC", name: "read" },
    { role: "tool", content: "r2", toolCallId: "toolu_02XYZ", name: "bash" },
  ];
  const out = normalizeConversationForProvider(conversation);
  const calls = out[1]?.toolCalls ?? [];
  assert.deepEqual(
    calls.map((c) => c.id),
    ["call_1", "call_2"],
    "each tool call gets a neutral id any provider accepts",
  );
  // The tool results still point at their originating call (pairing the target provider requires).
  assert.equal(out[2]?.toolCallId, "call_1");
  assert.equal(out[3]?.toolCallId, "call_2");
  // Names + arguments + content are untouched - only the id encoding changes.
  assert.equal(calls[0]?.name, "read");
  assert.equal(out[2]?.content, "r1");
});

test("strips an inlined assistant thinking-block signature so the new provider can verify the turn", () => {
  const conversation: ChatMessage[] = [
    {
      role: "assistant",
      content: "<thinking>signed-reasoning-blob</thinking>The answer is 42.",
    },
  ];
  const out = normalizeConversationForProvider(conversation);
  assert.equal(out[0]?.content, "The answer is 42.", "the thinking block is stripped, the answer kept");
});

test("a conversation with neutral content + no tools is returned unchanged in shape", () => {
  const conversation: ChatMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ];
  const out = normalizeConversationForProvider(conversation);
  assert.deepEqual(out, conversation);
});

test("is pure - it never mutates the input conversation", () => {
  const original: ChatMessage[] = [
    {
      role: "assistant",
      content: "x",
      toolCalls: [{ id: "toolu_99", name: "read", arguments: "{}" }],
    },
  ];
  const snapshot = JSON.parse(JSON.stringify(original));
  normalizeConversationForProvider(original);
  assert.deepEqual(original, snapshot, "the input array + its messages are untouched");
});
