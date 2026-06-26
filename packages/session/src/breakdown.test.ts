import assert from "node:assert/strict";
import { test } from "vitest";
import { addBreakdown, BREAKDOWN_GROUPS, rollupBreakdown, type UsageBreakdown } from "./breakdown";

/**
 * The breakdown schema is the single source of truth for "where did the call's tokens go" (D-013).
 * These pin the canonical DISPLAY rollup so the web treemap/legend can collapse to a thin adapter
 * over it - the grouping (tool results / overhead / thinking / answer) and the semantic colors live
 * here, not hardcoded per surface.
 */

const sample: UsageBreakdown = {
  input: {
    systemAndTools: 5_000,
    userText: 500,
    assistantText: 200,
    toolCallArgs: 100,
    toolResults: 3_000,
    imagesBase64: 9_999, // not a category - must never be summed into a group
    imageCount: 2,
    byTool: { read: 3_000 }, // not a category either
  },
  output: { thinking: 400, answer: 600, toolCallArgs: 50 },
};

test("rollupBreakdown groups the raw categories into the canonical display cells", () => {
  const rows = rollupBreakdown(sample);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  // tools = the non-overhead INPUT (tool results); overhead = the overhead input categories summed.
  assert.equal(byKey.tools, 3_000);
  assert.equal(byKey.overhead, 5_000 + 500 + 200 + 100);
  assert.equal(byKey.thinking, 400);
  assert.equal(byKey.answer, 600);
});

test("the rollup ignores non-category fields (images, byTool, output tool-call args)", () => {
  const rows = rollupBreakdown(sample);
  const total = rows.reduce((t, r) => t + r.value, 0);
  // 3000 tools + 5800 overhead + 400 thinking + 600 answer = 9800; the 9999 base64, the byTool map,
  // and the 50 output tool-call args are all excluded.
  assert.equal(total, 9_800);
});

test("rows come back in descriptor order, each carrying its group label + color", () => {
  const rows = rollupBreakdown(sample);
  assert.deepEqual(
    rows.map((r) => r.key),
    BREAKDOWN_GROUPS.map((g) => g.key),
  );
  const tools = rows.find((r) => r.key === "tools");
  assert.equal(tools?.label, "tool results");
  assert.equal(tools?.color, "smui-frost-3");
});

test("zero-value groups are kept (the caller drops them, not the rollup)", () => {
  const empty: UsageBreakdown = {
    input: {
      systemAndTools: 0,
      userText: 0,
      assistantText: 0,
      toolCallArgs: 0,
      toolResults: 0,
      imagesBase64: 0,
      imageCount: 0,
      byTool: {},
    },
    output: { thinking: 0, answer: 0, toolCallArgs: 0 },
  };
  const rows = rollupBreakdown(empty);
  assert.equal(rows.length, BREAKDOWN_GROUPS.length);
  assert.ok(rows.every((r) => r.value === 0));
});

test("the rollup of a summed breakdown equals summing the rollups (addBreakdown parity)", () => {
  const summed = rollupBreakdown(addBreakdown(sample, sample));
  for (const row of summed) {
    const single = rollupBreakdown(sample).find((r) => r.key === row.key)?.value ?? 0;
    assert.equal(row.value, single * 2, `${row.key} doubles under addBreakdown`);
  }
});
