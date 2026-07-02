import assert from "node:assert/strict";
import {
  BREAKDOWN_CATEGORIES,
  decodeTrevorEvent,
  events,
  type SessionEvent,
  type TrevorEventInput,
  type UsageBreakdown,
} from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { test } from "vitest";
import { BreakdownAccumulator } from "./breakdown";

/**
 * Characterization tests for the shared token-breakdown category schema (M2 / D-002).
 *
 * These pin the canonical category set and the wire `UsageBreakdown` shape BEFORE the
 * descriptor is introduced, so host accumulation, the wire type, coerceBreakdown, and
 * the web treemap can all be re-derived from one descriptor without drifting. The wire
 * field names are a hard constraint - the round-trip test fails if any change.
 */

const ev = (input: TrevorEventInput): SessionEvent =>
  storedEvent(input, { seq: 0, eventId: "e0", producerId: "trevor-host" });

const SAMPLE: UsageBreakdown = {
  input: {
    systemAndTools: 5000,
    userText: 120,
    assistantText: 80,
    toolCallArgs: 40,
    toolResults: 9000,
    imagesBase64: 2048,
    imageCount: 1,
    byTool: { read: 6000, grep: 3000 },
  },
  output: { thinking: 800, answer: 300, toolCallArgs: 40 },
};

test("the shared descriptor is the canonical category set, in pool order", () => {
  const inputKeys = BREAKDOWN_CATEGORIES.filter((c) => c.pool === "input").map((c) => c.key);
  const outputKeys = BREAKDOWN_CATEGORIES.filter((c) => c.pool === "output").map((c) => c.key);
  assert.deepEqual(inputKeys, [
    "systemAndTools",
    "userText",
    "assistantText",
    "toolCallArgs",
    "toolResults",
  ]);
  assert.deepEqual(outputKeys, ["thinking", "answer", "toolCallArgs"]);
});

test("overhead is every input text category except tool results (the web rollup)", () => {
  const overhead = BREAKDOWN_CATEGORIES.filter((c) => c.pool === "input" && c.isOverhead).map(
    (c) => c.key,
  );
  assert.deepEqual(overhead, ["systemAndTools", "userText", "assistantText", "toolCallArgs"]);
  const dynamic = BREAKDOWN_CATEGORIES.filter((c) => c.pool === "input" && !c.isOverhead).map(
    (c) => c.key,
  );
  assert.deepEqual(dynamic, ["toolResults"]);
});

test("a host snapshot carries exactly the descriptor's categories (+ image/byTool specials)", () => {
  const acc = new BreakdownAccumulator(5000);
  acc.seedHistory([{ role: "user", content: "hi" }]);
  acc.onToolResult("read", 100);
  acc.onThinking(50);
  acc.onAnswer(10);
  const snap = acc.snapshot();
  for (const c of BREAKDOWN_CATEGORIES) {
    const pool = snap[c.pool] as Record<string, unknown>;
    assert.ok(c.key in pool, `${c.pool}.${c.key} present in snapshot`);
    assert.equal(typeof pool[c.key], "number");
  }
  assert.equal(typeof snap.input.imagesBase64, "number");
  assert.equal(typeof snap.input.imageCount, "number");
  assert.equal(typeof snap.input.byTool, "object");
});

test("the wire UsageBreakdown round-trips through encode/decode unchanged", () => {
  const event = ev(events.assistantCompleted({ runId: "r1", text: "done", breakdown: SAMPLE }));
  const decoded = decodeTrevorEvent(event);
  assert.ok(decoded && decoded.type === "assistant.completed");
  assert.deepEqual(decoded.breakdown, SAMPLE);
});
