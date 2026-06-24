import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../providers";
import { sanitizeHistory } from "./history";

test("drops a blank (whitespace-only) assistant turn - the poison", () => {
  // The blank reply means "hey" went unanswered; dropping it leaves two adjacent user
  // turns, which then collapse to the latest (an unanswered prompt is superseded).
  const out = sanitizeHistory([
    { role: "user", content: "hey" },
    { role: "assistant", content: "\n\n\n\n\n" },
    { role: "user", content: "audit this codebase" },
  ]);
  assert.deepEqual(out, [{ role: "user", content: "audit this codebase" }]);
});

test("keeps a real assistant reply between the user turns", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello there" },
    { role: "user", content: "audit this codebase" },
  ];
  assert.deepEqual(sanitizeHistory(msgs), msgs);
});

test("keeps a tool-call step with empty content", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "read it" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
    { role: "tool", content: "file body", toolCallId: "c1", name: "read" },
  ];
  assert.deepEqual(sanitizeHistory(msgs), msgs);
});

test("collapses a run of consecutive user turns to the latest", () => {
  const out = sanitizeHistory([
    { role: "user", content: "hey" },
    { role: "user", content: "hey" },
    { role: "user", content: "audit this codebase" },
  ]);
  assert.deepEqual(out, [{ role: "user", content: "audit this codebase" }]);
});

test("drops leading non-user turns so the prompt opens on a user message", () => {
  const out = sanitizeHistory([
    { role: "assistant", content: "stray reply" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
});

test("leaves a well-formed conversation unchanged", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "audit this codebase" },
  ];
  assert.deepEqual(sanitizeHistory(msgs), msgs);
});
