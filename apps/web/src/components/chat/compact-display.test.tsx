import assert from "node:assert/strict";
import { LoaderIcon, Sparkles, TriangleAlert, Wrench } from "lucide-react";
import { test } from "vitest";
import type { AssistantMessage, Message } from "../../transcript";
import { compactDisplayFor, isCompactEligible, staysFullInCompact } from "./compact-display";

/**
 * M1: the compact display contract + eligibility classification. Proves user prompts and final
 * assistant responses stay full (no compact descriptor), while every other row kind - thinking,
 * tools, command/shell results, status markers, delegation, questions - projects to a one-line
 * descriptor with the right status/icon/labels.
 */

function assistant(over: Partial<AssistantMessage>): AssistantMessage {
  return {
    kind: "assistant",
    id: "a1",
    runId: "r1",
    text: "",
    thinking: "",
    done: true,
    warm: false,
    model: "glm",
    ...over,
  };
}

const tool = (over: Partial<Extract<Message, { kind: "tool" }>>): Message => ({
  kind: "tool",
  id: "t1",
  name: "bash",
  args: JSON.stringify({ command: "ls -la /tmp" }),
  done: true,
  ...over,
});

test("user prompts and final assistant responses stay full (no compact descriptor)", () => {
  const user: Message = { kind: "user", id: "u1", text: "hello", artifacts: [], pastes: [] };
  assert.equal(staysFullInCompact(user), true);
  assert.equal(compactDisplayFor(user), null);

  const response = assistant({ text: "Here is the answer.", thinking: "ponder" });
  assert.equal(staysFullInCompact(response), true);
  assert.equal(compactDisplayFor(response), null);
  assert.equal(isCompactEligible(response), false);
});

test("a streaming thinking-only segment compacts to a running 'Thinking' row", () => {
  const seg = assistant({ text: "", thinking: "weighing options\nmore", done: false });
  const d = compactDisplayFor(seg);
  assert.ok(d);
  assert.equal(d.status, "running");
  assert.equal(d.icon, LoaderIcon);
  assert.equal(d.primary, "Thinking");
  assert.equal(d.secondary, "weighing options");
  assert.equal(d.hasDetail, true);
});

test("a settled thought (no final text) compacts to an info 'Thought' row", () => {
  const d = compactDisplayFor(assistant({ text: "", thinking: "hmm", done: true }));
  assert.ok(d);
  assert.equal(d.status, "info");
  assert.equal(d.icon, Sparkles);
  assert.equal(d.primary, "Thought");
});

test("an assistant error compacts to an error row even with no text", () => {
  const d = compactDisplayFor(assistant({ text: "", error: "boom: provider 500" }));
  assert.ok(d);
  assert.equal(d.status, "error");
  assert.equal(d.icon, TriangleAlert);
  assert.equal(d.primary, "Error");
  assert.equal(d.secondary, "boom: provider 500");
});

test("terminal non-answers (cancelled / interrupted / no-reply) compact to info rows", () => {
  for (const [over, label] of [
    [{ cancelled: true }, "Cancelled"],
    [{ interrupted: true }, "Interrupted"],
    [{ noReply: true }, "No reply"],
  ] as const) {
    const d = compactDisplayFor(assistant({ text: "", ...over }));
    assert.ok(d);
    assert.equal(d.status, "info");
    assert.equal(d.primary, label);
  }
});

test("a running tool compacts to a spinner row with name + summary", () => {
  const d = compactDisplayFor(tool({ done: false }));
  assert.ok(d);
  assert.equal(d.status, "running");
  assert.equal(d.icon, LoaderIcon);
  assert.equal(d.primary, "bash");
  assert.equal(d.secondary, "ls -la /tmp");
  assert.equal(d.hasDetail, false);
});

test("a completed tool is done with detail; a failed/aborted tool is an error", () => {
  const done = compactDisplayFor(tool({ done: true, result: "total 0" }));
  assert.ok(done);
  assert.equal(done.status, "done");
  assert.equal(done.icon, Wrench);
  assert.equal(done.hasDetail, true);

  assert.equal(compactDisplayFor(tool({ done: true, result: "error: nope" }))?.status, "error");
  assert.equal(compactDisplayFor(tool({ done: false, aborted: true }))?.status, "error");
});

test("command and shell results carry ok/error status and a first-line summary", () => {
  const ok = compactDisplayFor({
    kind: "result",
    id: "c1",
    command: "doctor",
    text: "all green\nmore",
    ok: true,
  });
  assert.ok(ok);
  assert.equal(ok.status, "done");
  assert.equal(ok.primary, "doctor");
  assert.equal(ok.secondary, "all green");

  const shellFail = compactDisplayFor({
    kind: "shell",
    id: "s1",
    requestId: "rq1",
    command: "git push",
    done: true,
    ok: false,
    output: "rejected",
  });
  assert.equal(shellFail?.status, "error");
  assert.equal(shellFail?.primary, "git push");
});

test("status markers (recovered / continued / reconnecting / guardrail / compacting) compact", () => {
  const cases: Message[] = [
    {
      kind: "recovered",
      id: "r",
      action: "Trimmed a tool result",
      detail: "freed 2k",
      reclaimed: 2048,
    },
    { kind: "continued", id: "c", steps: 12, pressure: 0.4, detail: "headroom + progress" },
    { kind: "reconnecting", id: "rc", attempt: 2, maxAttempts: 3, detail: "stream dropped" },
    { kind: "guardrail", id: "g", tool: "bash", action: "blocked", reason: "repeat", count: 3 },
    { kind: "compacting", id: "cm", foldId: "f1", tokens: 400, budget: 1000 },
  ];
  for (const m of cases) {
    const d = compactDisplayFor(m);
    assert.ok(d, `${m.kind} should compact`);
    assert.equal(d.kind, m.kind);
    assert.ok(d.primary.length > 0);
  }
  assert.equal(compactDisplayFor(cases[2] as Message)?.status, "running");
  assert.equal(compactDisplayFor(cases[3] as Message)?.primary, "Guardrail: bash");
});

test("a delegation row reflects its child status, and a question row is detail-eligible", () => {
  const running = compactDisplayFor({
    kind: "delegation",
    id: "d1",
    childSessionId: "child",
    agent: "Explore",
    task: "map the code",
    mode: "async",
    status: "running",
  });
  assert.equal(running?.status, "running");
  assert.equal(running?.primary, "Explore");

  const q = compactDisplayFor({
    kind: "question",
    id: "q1",
    questionId: "qq",
    runId: "r1",
    outcome: "answered",
    items: [{ id: "i1", question: "Which?", answer: "A" }],
    summary: "Picked A",
  });
  assert.equal(q?.primary, "Asked");
  assert.equal(q?.hasDetail, true);
});

test("every non-primary kind is compact-eligible; user/response are not", () => {
  const eligible: Message[] = [
    assistant({ text: "", thinking: "x", done: false }),
    tool({}),
    { kind: "result", id: "c", command: "x", text: "y", ok: true },
    { kind: "shell", id: "s", requestId: "r", command: "ls", done: true },
    { kind: "recovered", id: "r", action: "a", detail: "d", reclaimed: 1 },
    {
      kind: "question",
      id: "q",
      questionId: "q",
      runId: "r",
      outcome: "answered",
      items: [],
      summary: "s",
    },
  ];
  for (const m of eligible) {
    assert.equal(isCompactEligible(m), true, `${m.kind} eligible`);
  }
  assert.equal(
    isCompactEligible({ kind: "user", id: "u", text: "hi", artifacts: [], pastes: [] }),
    false,
  );
  assert.equal(isCompactEligible(assistant({ text: "answer" })), false);
});
