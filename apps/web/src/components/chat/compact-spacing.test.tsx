import assert from "node:assert/strict";
import { test } from "vitest";
import type { Message, ToolMessage } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";
import { compactLeadingGaps, compactTypeKey, toolTypeKey } from "./compact-spacing";

/**
 * M1 (plan 58): the compact type taxonomy + spacing derivation. Proves the type key groups read-only
 * tools into one bucket, keys other tools by name, keeps MCP tools always separate, and derives the
 * per-row leading gaps (flush within a type, one spacer between types, no leading gap on the first row).
 */

function messageRow(message: Message): TranscriptRow {
  return { kind: "message", id: `message:${message.id}`, message, compactAbove: false };
}

let seq = 0;
function toolRow(name: string, over: Partial<ToolMessage> = {}): TranscriptRow {
  seq += 1;
  return messageRow({ kind: "tool", id: `t${seq}`, name, args: "{}", done: true, ...over });
}

function batchRow(...names: string[]): TranscriptRow {
  const tools: ToolMessage[] = names.map((name, index) => ({
    kind: "tool",
    id: `b${index}`,
    name,
    args: "{}",
    done: true,
  }));
  return { kind: "tool_batch", id: "tool-batch:b0", tools, compactAbove: false };
}

const user: Message = { kind: "user", id: "u1", text: "hi", artifacts: [], pastes: [] };
const assistant: Message = {
  kind: "assistant",
  id: "a1",
  runId: "r1",
  text: "answer",
  thinking: "",
  done: true,
  warm: false,
  model: "glm",
};
const question: Message = {
  kind: "question",
  id: "q1",
  questionId: "qq",
  runId: "r1",
  outcome: "answered",
  items: [],
  summary: "picked A",
};
const inlineAgent: Message = {
  kind: "inlineAgent",
  id: "ia1",
  parentRunId: "r1",
  agents: [{ childSessionId: "s::sub::a", agent: "explorer", status: "running", model: "qwen3" }],
};

test("non-tool rows key by Message.kind", () => {
  assert.equal(compactTypeKey(messageRow(user)), "user");
  assert.equal(compactTypeKey(messageRow(assistant)), "assistant");
  assert.equal(compactTypeKey(messageRow(question)), "question");
});

test("read-only tools and a tool_batch share the single readonly key", () => {
  assert.equal(compactTypeKey(toolRow("read")), "readonly");
  assert.equal(compactTypeKey(toolRow("glob")), "readonly");
  assert.equal(compactTypeKey(toolRow("grep")), "readonly");
  assert.equal(compactTypeKey(batchRow("read", "glob")), "readonly");
});

test("non-read-only tools key by name; consecutive same-name calls share a key", () => {
  assert.equal(compactTypeKey(toolRow("edit")), "tool:edit");
  assert.equal(compactTypeKey(toolRow("bash")), "tool:bash");
  assert.equal(compactTypeKey(toolRow("write")), "tool:write");
  // Two distinct edit calls resolve to the same key, so they sit flush.
  assert.equal(compactTypeKey(toolRow("edit")), compactTypeKey(toolRow("edit")));
});

test("MCP tools are their own type, checked before the read-only bucket", () => {
  assert.equal(toolTypeKey("mcp"), "mcp:mcp");
  assert.equal(toolTypeKey("mcp__github__create_issue"), "mcp:mcp__github__create_issue");
  // MCP is checked first, so an MCP tool is never folded into the read-only bucket.
  assert.notEqual(toolTypeKey("mcp"), "readonly");
  assert.notEqual(toolTypeKey("mcp__anything"), "readonly");
  // Sanity: the read-only bucket and the by-name path still work for non-MCP tools.
  assert.equal(toolTypeKey("read"), "readonly");
  assert.equal(toolTypeKey("edit"), "tool:edit");
});

test("compactLeadingGaps: flush within a type, one gap between types, first row no gap", () => {
  const rows = [
    messageRow(user), // user
    messageRow(assistant), // assistant -> gap
    toolRow("read"), // readonly -> gap
    toolRow("glob"), // readonly -> flush
    toolRow("edit"), // tool:edit -> gap
    toolRow("edit"), // tool:edit -> flush
    toolRow("bash"), // tool:bash -> gap
    toolRow("mcp__github__create_issue"), // mcp:... -> gap
  ];
  assert.deepEqual(compactLeadingGaps(rows), [false, true, true, false, true, false, true, true]);
});

test("a tool_batch and an adjacent lone read-only tool sit flush; a mutating tool opens a gap", () => {
  const rows = [batchRow("read", "glob"), toolRow("read"), toolRow("edit")];
  assert.deepEqual(compactLeadingGaps(rows), [false, false, true]);
});

test("58.1 M3: a full inline-agent block opens exactly one compact gap at type boundaries", () => {
  const rows = [toolRow("read"), messageRow(inlineAgent), toolRow("read")];
  assert.deepEqual(compactLeadingGaps(rows), [false, true, true]);
});

test("an empty transcript yields no gaps", () => {
  assert.deepEqual(compactLeadingGaps([]), []);
});
