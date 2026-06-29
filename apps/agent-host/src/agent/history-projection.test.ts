import assert from "node:assert/strict";
import {
  events,
  PRODUCER_IDS,
  type ProducerId,
  type SessionEvent,
  type TrevorEventInput,
} from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { test } from "vitest";
import type { ChatMessage } from "../providers";
import { buildHistory } from "./history-projection";

/**
 * Tests for the host history projection (the prompt the model is handed each turn). The fold:
 *   - user.message (not self-authored)  -> push {role:"user", content[, artifacts]},
 *     collapsing onto a preceding user turn (alternation)
 *   - tool.started / tool.completed     -> RECONSTRUCTED into the conversation (an assistant
 *     tool-call message + its tool results), carried ACROSS turns so the model keeps what it read
 *     until compaction folds it (mainstream-harness behaviour)
 *   - assistant.completed, non-blank    -> push {role:"assistant", content}
 *   - assistant.completed, blank        -> dropped (the empty-reply poison)
 *   - context.compacted                 -> the cross-turn fold (D-040): pins + summary + recent
 *   - user.command "/clear" (not self)  -> reset the projection to empty
 *   - everything else (started, delta, thinking, host events) -> ignored
 *
 * The host's own producerId is excluded for user.message / user.command (main.ts
 * gates both on `producerId !== PRODUCER_ID`); assistant.completed is folded
 * regardless of producer.
 */

const SELF: ProducerId = PRODUCER_IDS.host;
const WEB: ProducerId = PRODUCER_IDS.web;

let seq = 0;
/** Wraps an `events.*` constructor output in a durable-log envelope for the fold. */
const ev = (input: TrevorEventInput, producerId: ProducerId = WEB): SessionEvent =>
  storedEvent(input, { seq: seq++, producerId });

const project = (log: SessionEvent[]): ChatMessage[] => buildHistory(log, { selfProducerId: SELF });

/** A `context.compacted` fold event with a minimal manifest, for the compaction (D-040) tests. */
const fold = (p: { throughSeq: number; summary: string; supersedes?: string }): TrevorEventInput =>
  events.contextCompacted({
    foldId: `fold-${p.throughSeq}`,
    throughSeq: p.throughSeq,
    ...(p.supersedes ? { supersedes: p.supersedes } : {}),
    summary: p.summary,
    manifest: { turnRange: { fromSeq: 0, toSeq: p.throughSeq }, files: [], tools: [], topics: [] },
    tokensBefore: 0,
    tokensAfter: 0,
    model: "qwen",
  });

test("folds a full turn log into strictly paired user/assistant messages", () => {
  const log = [
    ev(events.userMessage({ text: "hi", provider: "qwen" })),
    ev(events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" }), SELF),
    ev(events.assistantDelta({ runId: "r1", text: "hel" }), SELF),
    ev(events.assistantCompleted({ runId: "r1", text: "hello" }), SELF),
    ev(events.userMessage({ text: "bye", provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r2", text: "goodbye" }), SELF),
  ];
  assert.deepEqual(project(log), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "bye" },
    { role: "assistant", content: "goodbye" },
  ]);
});

test("drops a blank assistant completion, then collapses the orphaned user turns", () => {
  // "hey" went unanswered (blank reply dropped), leaving two adjacent user turns,
  // which collapse to the latest - exactly the existing sanitizeHistory contract.
  const log = [
    ev(events.userMessage({ text: "hey", provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r1", text: "\n\n\n\n" }), SELF),
    ev(events.userMessage({ text: "audit this codebase", provider: "qwen" })),
  ];
  assert.deepEqual(project(log), [{ role: "user", content: "audit this codebase" }]);
});

test("collapses a run of consecutive user turns to the latest (abandoned turn)", () => {
  const log = [
    ev(events.userMessage({ text: "a", provider: "qwen" })),
    ev(events.userMessage({ text: "b", provider: "qwen" })),
  ];
  assert.deepEqual(project(log), [{ role: "user", content: "b" }]);
});

test("drops a leading assistant completion so the prompt opens on a user turn", () => {
  // A completion arriving before any user message (e.g. a /clear that landed
  // mid-answer) must not lead the prompt - the model sees only the later turn.
  // This is the unique defense folded in from the old sanitizeHistory pass.
  const log = [
    ev(events.assistantCompleted({ runId: "r0", text: "stray reply" }), SELF),
    ev(events.userMessage({ text: "hi", provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r1", text: "hello" }), SELF),
  ];
  assert.deepEqual(project(log), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
});

test("/clear resets the projection mid-stream", () => {
  const log = [
    ev(events.userMessage({ text: "first", provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r1", text: "reply" }), SELF),
    ev(events.userCommand({ command: "/clear", args: "" })),
    ev(events.userMessage({ text: "after clear", provider: "qwen" })),
  ];
  assert.deepEqual(project(log), [{ role: "user", content: "after clear" }]);
});

test("/clear with nothing after it yields an empty projection", () => {
  const log = [
    ev(events.userMessage({ text: "first", provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r1", text: "reply" }), SELF),
    ev(events.userCommand({ command: "/clear", args: "" })),
  ];
  assert.deepEqual(project(log), []);
});

test("reconstructs tool round-trips into the conversation, carrying results forward", () => {
  // tool.started + tool.completed become an assistant tool-call message + its tool result, so the
  // model keeps what it read. Host chatter (started/thinking/beat) and self-authored user echoes
  // are still ignored.
  const log = [
    ev(events.userMessage({ text: "read it", provider: "qwen" })),
    // A self-authored user.message is the host's own echo - never folded.
    ev(events.userMessage({ text: "echo", provider: "qwen" }), SELF),
    ev(events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" }), SELF),
    ev(events.assistantThinking({ runId: "r1", text: "hmm" }), SELF),
    ev(
      events.toolStarted({ runId: "r1", callId: "c1", name: "read", arguments: '{"path":"a"}' }),
      SELF,
    ),
    ev(events.toolCompleted({ runId: "r1", callId: "c1", name: "read", result: "body" }), SELF),
    ev(events.hostBeat({ instanceId: "abc" }), SELF),
    ev(events.assistantCompleted({ runId: "r1", text: "the file says hi" }), SELF),
  ];
  assert.deepEqual(project(log), [
    { role: "user", content: "read it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"a"}' }],
    },
    { role: "tool", content: "body", toolCallId: "c1", name: "read" },
    { role: "assistant", content: "the file says hi" },
  ]);
});

test("a concurrent read batch reconstructs as one assistant message + its tool results", () => {
  // Three reads in one step: hoisted tool.started (call order), then tool.completed in COMPLETION
  // order (D-050). One assistant tool-call message carries all three calls; the results follow.
  const log = [
    ev(events.userMessage({ text: "read these", provider: "qwen" })),
    ev(
      events.toolStarted({ runId: "r1", callId: "a", name: "read", arguments: '{"path":"1"}' }),
      SELF,
    ),
    ev(
      events.toolStarted({ runId: "r1", callId: "b", name: "read", arguments: '{"path":"2"}' }),
      SELF,
    ),
    ev(
      events.toolStarted({ runId: "r1", callId: "c", name: "grep", arguments: '{"pattern":"x"}' }),
      SELF,
    ),
    // completions arrive out of call order
    ev(events.toolCompleted({ runId: "r1", callId: "c", name: "grep", result: "match" }), SELF),
    ev(events.toolCompleted({ runId: "r1", callId: "a", name: "read", result: "one" }), SELF),
    ev(events.toolCompleted({ runId: "r1", callId: "b", name: "read", result: "two" }), SELF),
    ev(events.assistantCompleted({ runId: "r1", text: "done" }), SELF),
  ];
  assert.deepEqual(project(log), [
    { role: "user", content: "read these" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "read", arguments: '{"path":"1"}' },
        { id: "b", name: "read", arguments: '{"path":"2"}' },
        { id: "c", name: "grep", arguments: '{"pattern":"x"}' },
      ],
    },
    { role: "tool", content: "match", toolCallId: "c", name: "grep" },
    { role: "tool", content: "one", toolCallId: "a", name: "read" },
    { role: "tool", content: "two", toolCallId: "b", name: "read" },
    { role: "assistant", content: "done" },
  ]);
});

test("tool results from a PRIOR turn are carried into the next turn's prompt", () => {
  // The whole point of the carry: turn 1 reads a file; turn 2's prompt still contains that read.
  const log = [
    ev(events.userMessage({ text: "read x", provider: "qwen" })),
    ev(
      events.toolStarted({ runId: "r1", callId: "c1", name: "read", arguments: '{"path":"x"}' }),
      SELF,
    ),
    ev(
      events.toolCompleted({ runId: "r1", callId: "c1", name: "read", result: "x contents" }),
      SELF,
    ),
    ev(events.assistantCompleted({ runId: "r1", text: "x has a function" }), SELF),
    ev(events.userMessage({ text: "now what about y?", provider: "qwen" })),
  ];
  assert.deepEqual(project(log), [
    { role: "user", content: "read x" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"x"}' }],
    },
    { role: "tool", content: "x contents", toolCallId: "c1", name: "read" },
    { role: "assistant", content: "x has a function" },
    { role: "user", content: "now what about y?" },
  ]);
});

test("a self-authored /clear is ignored (does not reset)", () => {
  const log = [
    ev(events.userMessage({ text: "keep me", provider: "qwen" })),
    ev(events.userCommand({ command: "/clear", args: "" }), SELF),
  ];
  assert.deepEqual(project(log), [{ role: "user", content: "keep me" }]);
});

test("a compaction fold projects to pins + rolling summary + recent verbatim turns", () => {
  const goalEv = ev(events.userMessage({ text: "build the thing", provider: "qwen" }));
  const a1 = ev(events.assistantCompleted({ runId: "r1", text: "started it" }), SELF);
  const u2 = ev(events.userMessage({ text: "keep going", provider: "qwen" }));
  const a2 = ev(events.assistantCompleted({ runId: "r2", text: "more progress" }), SELF);
  const foldEv = ev(fold({ throughSeq: a2.seq, summary: "Built the thing through step 2." }), SELF);
  const u3 = ev(events.userMessage({ text: "finish it", provider: "qwen" }));
  const a3 = ev(events.assistantCompleted({ runId: "r3", text: "done" }), SELF);

  // Folded: the original goal is pinned, the folded turns collapse to one summary message, and
  // the post-throughSeq turns stay verbatim.
  assert.deepEqual(project([goalEv, a1, u2, a2, foldEv, u3, a3]), [
    { role: "user", content: "build the thing" },
    {
      role: "assistant",
      content: "[Summary of earlier conversation]\nBuilt the thing through step 2.",
    },
    { role: "user", content: "finish it" },
    { role: "assistant", content: "done" },
  ]);

  // The SAME log without the fold projects in full - the fold shapes only the prompt, never the
  // durable history.
  assert.deepEqual(project([goalEv, a1, u2, a2, u3, a3]), [
    { role: "user", content: "build the thing" },
    { role: "assistant", content: "started it" },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "more progress" },
    { role: "user", content: "finish it" },
    { role: "assistant", content: "done" },
  ]);
});

test("the live task list rides in the fold message", () => {
  const goalEv = ev(events.userMessage({ text: "do tasks", provider: "qwen" }));
  const a1 = ev(events.assistantCompleted({ runId: "r1", text: "ok" }), SELF);
  const tasksEv = ev(
    events.tasksCurrent({
      tasks: [
        {
          id: "t1",
          subject: "wire the API",
          activeForm: "wiring the API",
          status: "in_progress",
          blockedBy: [],
          blocks: [],
        },
        {
          id: "t2",
          subject: "write tests",
          activeForm: "writing tests",
          status: "pending",
          blockedBy: [],
          blocks: [],
        },
      ],
    }),
    SELF,
  );
  const foldEv = ev(fold({ throughSeq: tasksEv.seq, summary: "Progress so far." }), SELF);
  const u2 = ev(events.userMessage({ text: "continue", provider: "qwen" }));

  const projected = project([goalEv, a1, tasksEv, foldEv, u2]);
  const summary = projected[1];
  assert.equal(summary?.role, "assistant");
  assert.match(summary?.content ?? "", /\[Current tasks\]/);
  assert.match(summary?.content ?? "", /- \[in_progress\] wire the API/);
  assert.match(summary?.content ?? "", /- \[pending\] write tests/);
});

test("a /clear after a fold drops the fold and pins, keeping only post-clear turns", () => {
  const goalEv = ev(events.userMessage({ text: "old goal", provider: "qwen" }));
  const a1 = ev(events.assistantCompleted({ runId: "r1", text: "old work" }), SELF);
  const foldEv = ev(fold({ throughSeq: a1.seq, summary: "old summary" }), SELF);
  const clearEv = ev(events.userCommand({ command: "/clear", args: "" }));
  const u2 = ev(events.userMessage({ text: "fresh start", provider: "qwen" }));

  assert.deepEqual(project([goalEv, a1, foldEv, clearEv, u2]), [
    { role: "user", content: "fresh start" },
  ]);
});

test("only the latest fold in the rolling chain is applied", () => {
  const goalEv = ev(events.userMessage({ text: "goal", provider: "qwen" }));
  const a1 = ev(events.assistantCompleted({ runId: "r1", text: "s1" }), SELF);
  const fold1 = ev(fold({ throughSeq: a1.seq, summary: "first summary" }), SELF);
  const u2 = ev(events.userMessage({ text: "more", provider: "qwen" }));
  const a2 = ev(events.assistantCompleted({ runId: "r2", text: "s2" }), SELF);
  const fold2 = ev(
    fold({ throughSeq: a2.seq, summary: "second summary", supersedes: "fold1" }),
    SELF,
  );
  const u3 = ev(events.userMessage({ text: "again", provider: "qwen" }));

  const projected = project([goalEv, a1, fold1, u2, a2, fold2, u3]);
  assert.equal(projected.length, 3);
  assert.equal(projected[0]?.content, "goal");
  assert.match(projected[1]?.content ?? "", /second summary/);
  assert.doesNotMatch(projected[1]?.content ?? "", /first summary/);
  assert.equal(projected[2]?.content, "again");
});

test("a recent turn arriving before the fold event is written is kept (blocking-before)", () => {
  // The blocking-before path: a new prompt lands, THEN compaction runs and appends the fold
  // (throughSeq points before the new prompt). The prompt has seq > throughSeq, so it is recent
  // and must survive even though it sits before the fold event in the log.
  const goalEv = ev(events.userMessage({ text: "goal", provider: "qwen" }));
  const a1 = ev(events.assistantCompleted({ runId: "r1", text: "answered" }), SELF);
  const newPrompt = ev(events.userMessage({ text: "next request", provider: "qwen" }));
  const foldEv = ev(fold({ throughSeq: a1.seq, summary: "summary up to the answer" }), SELF);

  assert.deepEqual(project([goalEv, a1, newPrompt, foldEv]), [
    { role: "user", content: "goal" },
    { role: "assistant", content: "[Summary of earlier conversation]\nsummary up to the answer" },
    { role: "user", content: "next request" },
  ]);
});

test("maps artifacts onto the user turn, omitting the key when there are none", () => {
  const artifact = {
    kind: "file" as const,
    mimeType: "text/plain",
    size: 10,
    hash: "a".repeat(64),
    name: "notes.txt",
  };
  const log = [
    ev(events.userMessage({ text: "with file", provider: "qwen", artifacts: [artifact] })),
    ev(events.assistantCompleted({ runId: "r1", text: "ok" }), SELF),
    ev(events.userMessage({ text: "no file", provider: "qwen" })),
  ];
  assert.deepEqual(project(log), [
    { role: "user", content: "with file", artifacts: [artifact] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "no file" },
  ]);
});

test("D-082: user.shell / shell.result are prompt-invisible (never reach the model)", () => {
  // A leading `!` ran a command, but for this cut the output is user-visible only. The projection
  // must carry the surrounding turn untouched and include nothing from the shell pair.
  const history = project([
    ev(events.userMessage({ text: "what is in this repo?", provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r1", text: "a monorepo" }), SELF),
    ev(events.userShell({ requestId: "rq1", command: "printf hello" })),
    ev(
      events.shellResult({ requestId: "rq1", command: "printf hello", output: "hello", ok: true }),
    ),
    ev(events.userMessage({ text: "thanks", provider: "qwen" })),
  ]);
  assert.deepEqual(history, [
    { role: "user", content: "what is in this repo?" },
    { role: "assistant", content: "a monorepo" },
    { role: "user", content: "thanks" },
  ]);
  // No message mentions the shell command or its output.
  assert.equal(
    history.some((m) => typeof m.content === "string" && m.content.includes("hello")),
    false,
  );
});
