import assert from "node:assert/strict";
import { test } from "vitest";
import type { Message } from "@/transcript";
import { findDetailModel, isDetailEligible, toToolDetailModel } from "./detail-model";

/**
 * M1: detail eligibility + the pure ToolDetailModel projection. Every tool row (including unknown / MCP
 * names) and the bang-shell lane is detail-eligible; user prompts and ordinary assistant responses are
 * not. The projection normalizes name / args / status / output / error from what the row carries today.
 */

function tool(over: Partial<Extract<Message, { kind: "tool" }>> = {}): Message {
  return { kind: "tool", id: "c1", name: "bash", args: '{"command":"ls"}', done: true, ...over };
}

const ELIGIBLE_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "multi_edit",
  "grep",
  "glob",
  "web_search",
  "web_fetch",
  "docs",
  "session_recall",
  "mcp__server__do_thing", // an unknown / MCP name outside the ToolName union
];

test("every tool row (incl. unknown/MCP) and the shell lane is detail-eligible", () => {
  for (const name of ELIGIBLE_TOOLS) {
    assert.equal(isDetailEligible(tool({ name })), true, `${name} is eligible`);
  }
  const shell: Message = {
    kind: "shell",
    id: "s1",
    requestId: "r1",
    command: "ls -la",
    done: true,
  };
  assert.equal(isDetailEligible(shell), true, "the shell lane is eligible");
});

test("user prompts and ordinary assistant responses are NOT detail targets", () => {
  const user: Message = { kind: "user", id: "u1", text: "hi", artifacts: [], pastes: [] };
  const assistant = { kind: "assistant", id: "a1" } as unknown as Message;
  assert.equal(isDetailEligible(user), false);
  assert.equal(isDetailEligible(assistant), false);
  assert.equal(toToolDetailModel(user), null, "a non-eligible row projects to null");
  assert.equal(toToolDetailModel(assistant), null);
});

test("a completed tool projects name, args, output, and a done status", () => {
  const m = toToolDetailModel(tool({ name: "read", args: '{"path":"a.ts"}', result: "file body" }));
  assert.deepEqual(
    {
      source: m?.source,
      toolName: m?.toolName,
      status: m?.status,
      args: m?.args,
      output: m?.output,
    },
    {
      source: "tool",
      toolName: "read",
      status: "done",
      args: '{"path":"a.ts"}',
      output: "file body",
    },
  );
  assert.equal(m?.error, undefined, "a done tool carries no error");
});

test("a running tool has running status and no output yet", () => {
  const m = toToolDetailModel(tool({ done: false, result: undefined }));
  assert.equal(m?.status, "running");
  assert.equal(m?.output, undefined);
});

test("an `error:` result is the error status with the failure text unwrapped", () => {
  const m = toToolDetailModel(tool({ result: "error: file not found" }));
  assert.equal(m?.status, "error");
  assert.equal(m?.error, "file not found");
});

test("an aborted tool is the error status with an aborted reason", () => {
  const m = toToolDetailModel(tool({ done: true, aborted: true }));
  assert.equal(m?.status, "error");
  assert.equal(m?.aborted, true);
  assert.equal(m?.error, "aborted before completion");
});

test("findDetailModel re-derives the detail live by source id (M6)", () => {
  // The same source id: a running tool, then the SAME row after tool.completed lands. The detail tracks
  // the live row, so its status/output flip from running to done without re-opening.
  const running: Message[] = [tool({ id: "c9", done: false, result: undefined })];
  const r = findDetailModel(running, "c9");
  assert.equal(r?.status, "running");
  assert.equal(r?.output, undefined);

  const completed: Message[] = [tool({ id: "c9", done: true, result: "42 files" })];
  const d = findDetailModel(completed, "c9");
  assert.equal(d?.status, "done");
  assert.equal(d?.output, "42 files");
});

test("findDetailModel is null for a closed takeover or a source row that has left the transcript", () => {
  const messages: Message[] = [tool({ id: "c1" })];
  assert.equal(findDetailModel(messages, null), null, "no id -> closed");
  assert.equal(findDetailModel(messages, "gone"), null, "source row left (e.g. /clear) -> closes");
});

test("a shell-lane row projects the command as args and is shell-sourced", () => {
  const failed: Message = {
    kind: "shell",
    id: "s2",
    requestId: "r2",
    command: "false",
    done: true,
    ok: false,
    output: "exit 1",
  };
  const m = toToolDetailModel(failed);
  assert.equal(m?.source, "shell");
  assert.equal(m?.toolName, "shell");
  assert.equal(m?.args, "false");
  assert.equal(m?.status, "error");
  assert.equal(m?.error, "exit 1");
});
