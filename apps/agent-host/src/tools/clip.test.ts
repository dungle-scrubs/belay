import assert from "node:assert/strict";
import { buildCommandRegistry } from "@host/commands/commands";
import type { ChatMessage } from "@host/providers/index";
import { buildTaskTools } from "@host/tools/tasks/tasks";
import { events } from "@trevor/session";
import { test } from "vitest";
import {
  buildClipTurnPrompt,
  CLIPBOARD_TOOL_NAMES,
  copyLastCopyable,
  lastCopyableText,
  routeClip,
} from "./clip";
import { CaptureClipboard, clipboardWriteTool } from "./clipboard";
import { offeredToolDefs } from "./index";

/**
 * M2 - bare `/clip` copies the last copyable transcript item through the host clipboard
 * abstraction, with no model turn. The capture writer keeps the real clipboard untouched (D-009).
 */

const msg = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });

test("lastCopyableText returns the most recent assistant or user text", () => {
  const history: ChatMessage[] = [msg("user", "first ask"), msg("assistant", "the answer to copy")];
  assert.equal(lastCopyableText(history), "the answer to copy");
});

test("lastCopyableText skips tool results and blank messages", () => {
  const history: ChatMessage[] = [
    msg("assistant", "real answer"),
    { role: "tool", content: "tool output", name: "grep", toolCallId: "c1" },
    msg("assistant", "   "),
  ];
  assert.equal(lastCopyableText(history), "real answer");
});

test("lastCopyableText returns null when nothing is copyable", () => {
  assert.equal(lastCopyableText([]), null);
  assert.equal(
    lastCopyableText([{ role: "tool", content: "x", name: "read", toolCallId: "c1" }]),
    null,
  );
});

test("copyLastCopyable writes the last copyable item and reports a bounded preview + char count", async () => {
  const capture = new CaptureClipboard();
  const answer = "Ship the release after the smoke suite is green.";
  const result = await copyLastCopyable(
    [msg("user", "what next?"), msg("assistant", answer)],
    capture,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(capture.writes, [answer], "the exact transcript text is copied verbatim");
  assert.match(result.text, new RegExp(`${answer.length} chars`));
  assert.ok(result.text.includes("Ship the release"), "a bounded preview is shown");
});

test("copyLastCopyable bounds the preview for a long item but copies it whole", async () => {
  const capture = new CaptureClipboard();
  const long = "x".repeat(500);
  const result = await copyLastCopyable([msg("assistant", long)], capture);

  assert.equal(result.ok, true);
  assert.deepEqual(capture.writes, [long], "the full text is copied, not the bounded preview");
  assert.ok(result.text.includes("…"), "the preview is truncated");
  assert.ok(result.text.length < long.length, "the result line is bounded, not the whole answer");
});

test("copyLastCopyable returns a clear nothing-to-copy result for empty history", async () => {
  const capture = new CaptureClipboard();
  const result = await copyLastCopyable([], capture);

  assert.equal(result.ok, false);
  assert.match(result.text, /nothing to copy/i);
  assert.deepEqual(capture.writes, [], "no clipboard write happens when there is nothing to copy");
});

test("copyLastCopyable surfaces a clipboard write failure as a not-ok result", async () => {
  const failing = new CaptureClipboard("no clipboard command available");
  const result = await copyLastCopyable([msg("assistant", "answer")], failing);

  assert.equal(result.ok, false);
  assert.match(result.text, /failed/i);
});

test("routeClip sends bare /clip to the immediate copy path (no model turn)", () => {
  assert.deepEqual(routeClip(""), { kind: "copy" });
  assert.deepEqual(routeClip("   "), { kind: "copy" });
});

/**
 * M3 - `/clip <request>` runs a restricted clipboard-only model turn: routed to a turn with a
 * prompt that frames the request, exposing only clipboard_write and forbidding shell clipboard
 * commands and every other tool surface.
 */

test("routeClip sends /clip <request> to a restricted clipboard turn carrying the request", () => {
  const route = routeClip("summarize the last answer for Slack");
  assert.equal(route.kind, "turn");
  if (route.kind !== "turn") {
    return;
  }
  assert.ok(route.prompt.includes("summarize the last answer for Slack"), "the request is carried");
  assert.ok(/clipboard_write/.test(route.prompt), "the turn is told to call clipboard_write");
});

test("the clip turn prompt restricts the model to context + clipboard_write and forbids shell", () => {
  const prompt = buildClipTurnPrompt("copy the final command");
  assert.ok(/clipboard_write/.test(prompt), "calls out clipboard_write");
  assert.ok(/existing conversation|context/i.test(prompt), "resolve from existing context only");
  assert.ok(/shell|pbcopy/i.test(prompt), "forbids shell clipboard commands");
});

test("the restricted clip turn exposes ONLY clipboard_write", () => {
  const offered = offeredToolDefs(true, CLIPBOARD_TOOL_NAMES, undefined).map((def) => def.name);
  assert.deepEqual(offered, ["clipboard_write"]);
});

test("the restricted clip turn cannot see shell, files, process, web, docs, MCP, or task tools", () => {
  const offered = new Set(
    offeredToolDefs(true, CLIPBOARD_TOOL_NAMES, undefined).map((d) => d.name),
  );
  for (const forbidden of [
    "bash",
    "read",
    "write",
    "edit",
    "multi_edit",
    "glob",
    "grep",
    "process",
    "web_search",
    "web_fetch",
    "docs",
    "task_create",
    "task_update",
    "skill",
  ]) {
    assert.equal(offered.has(forbidden), false, `${forbidden} must be unavailable in a clip turn`);
  }
});

test("CLIPBOARD_TOOL_NAMES is exactly the clipboard_write surface", () => {
  assert.deepEqual([...CLIPBOARD_TOOL_NAMES], ["clipboard_write"]);
});

test("clipboard_write guidance rejects shell clipboard commands (pbcopy/clip/wl-copy)", () => {
  const description = clipboardWriteTool.description.toLowerCase();
  assert.ok(description.includes("pbcopy"), "names pbcopy");
  assert.ok(
    /never (suggest|describe|run)/.test(description),
    "forbids running a shell clipboard command",
  );
});

/**
 * M4 - visibility without new product surface: the clipboard feature adds no `/doctor` area
 * (D-003), no task-panel state (D-005), and no persisted special clipboard state (D-004). Copied
 * content is visible only as ordinary command/tool results.
 */

test("clip adds no /doctor area: the /doctor summary still enumerates only its existing areas", () => {
  const registry = buildCommandRegistry();
  const doctor = registry.specs.find((spec) => spec.name === "/doctor");
  assert.ok(doctor, "/doctor is announced");
  assert.equal(/clip/i.test(`${doctor.summary} ${doctor.usage ?? ""}`), false, "no clipboard area");
});

test("clip adds no task tools: the task surface is exactly task_create + task_update + task_list", () => {
  const names = buildTaskTools().map((tool) => tool.name);
  assert.deepEqual(names, ["task_create", "task_update", "task_list"]);
});

test("there is no persisted special clipboard event or state in the protocol", () => {
  const eventNames = Object.keys(events);
  for (const name of eventNames) {
    assert.equal(/clip|clipboard/i.test(name), false, `no clipboard-specific event (${name})`);
  }
});
