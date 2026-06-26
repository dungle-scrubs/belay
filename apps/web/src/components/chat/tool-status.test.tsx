import assert from "node:assert/strict";
import { test } from "vitest";
import { toolStatusColor } from "./tool-status";

/**
 * One status→color config (D-014) shared by the transcript tool row and the concurrent-batch rows, so
 * the two cannot drift. The base color is identical across contexts; only the transcript row pulses a
 * running call (the concurrent batch leaves it still - its leading spinner already animates).
 */

test("each status maps to its wrench color", () => {
  assert.match(toolStatusColor("running"), /text-smui-yellow/);
  assert.match(toolStatusColor("done"), /text-smui-frost-3/);
  assert.match(toolStatusColor("error"), /text-smui-red/);
});

test("pulse adds the running animation only for the running state", () => {
  assert.match(toolStatusColor("running", true), /animate-pulse/);
  assert.ok(!toolStatusColor("done", true).includes("animate-pulse"), "done never pulses");
  assert.ok(!toolStatusColor("error", true).includes("animate-pulse"), "error never pulses");
});

test("without pulse the running color carries no animation (the concurrent-batch row)", () => {
  assert.ok(!toolStatusColor("running").includes("animate-pulse"));
  assert.match(toolStatusColor("running"), /text-smui-yellow/);
});
