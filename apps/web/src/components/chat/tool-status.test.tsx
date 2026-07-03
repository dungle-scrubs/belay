import assert from "node:assert/strict";
import { AlertCircleIcon, CheckIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import { test } from "vitest";
import { shellMessageStatus, statusIcon, toolMessageStatus, toolStatusColor } from "./tool-status";

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

test("tool message status derives aborted, running, done, and error results", () => {
  assert.equal(toolMessageStatus({ aborted: true, done: false }), "error");
  assert.equal(toolMessageStatus({ done: false }), "running");
  assert.equal(toolMessageStatus({ done: true, result: "ok" }), "done");
  assert.equal(toolMessageStatus({ done: true, result: "error: nope" }), "error");
});

test("shell message status derives running, done, and failed commands", () => {
  assert.equal(shellMessageStatus({ done: false }), "running");
  assert.equal(shellMessageStatus({ done: true }), "done");
  assert.equal(shellMessageStatus({ done: true, ok: true }), "done");
  assert.equal(shellMessageStatus({ done: true, ok: false }), "error");
});

/**
 * The shared status -> icon map (M29): the assistant-ui tool-fallback's lifecycle icons, moved here
 * so every surface that shows a tool-call status icon reads one map instead of a local copy.
 */
test("each assistant-ui tool status maps to its lifecycle icon", () => {
  assert.equal(statusIcon("running"), LoaderIcon);
  assert.equal(statusIcon("complete"), CheckIcon);
  assert.equal(statusIcon("incomplete"), XCircleIcon);
  assert.equal(statusIcon("requires-action"), AlertCircleIcon);
});
