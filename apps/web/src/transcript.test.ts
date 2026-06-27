import assert from "node:assert/strict";
import {
  events,
  type SessionEvent,
  type TrevorEventInput,
  type UsageBreakdown,
} from "@trevor/session";
import { test } from "vitest";
import { type Message, panelModel, readOnlyToolBatches, toTranscript } from "./transcript";

const usage = {
  input: 5_800,
  output: 200,
  contextWindow: 65_536,
  genMs: 1_000,
};

const breakdown: UsageBreakdown = {
  input: {
    systemAndTools: 5_000,
    userText: 500,
    assistantText: 0,
    toolCallArgs: 0,
    toolResults: 300,
    imagesBase64: 0,
    imageCount: 0,
    byTool: { read: 300 },
  },
  output: { thinking: 100, answer: 100, toolCallArgs: 0 },
};

function ev(seq: number, input: TrevorEventInput): SessionEvent {
  return {
    createdAt: "2026-06-24T00:00:00.000Z",
    eventId: `e${seq}`,
    payload: input.payload,
    producerId: "trevor-host",
    seq,
    sessionId: "test",
    type: input.type,
  };
}

test("M4: tool results land by call id when tool.completed arrives out of call order", () => {
  // Phase 1 (D-050) runs a step's read-only calls concurrently. tool.started is hoisted in CALL
  // order, but tool.completed rides out in COMPLETION order. The web keys results on callId
  // (toolByCall), so each result must land on its own card no matter the completion order.
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(
      2,
      events.toolStarted({ runId: "r1", callId: "c0", name: "read", arguments: '{"path":"0"}' }),
    ),
    ev(
      3,
      events.toolStarted({ runId: "r1", callId: "c1", name: "read", arguments: '{"path":"1"}' }),
    ),
    ev(
      4,
      events.toolStarted({ runId: "r1", callId: "c2", name: "read", arguments: '{"path":"2"}' }),
    ),
    // Completions arrive shuffled: c2 first, then c0, then c1.
    ev(5, events.toolCompleted({ runId: "r1", callId: "c2", name: "read", result: "result-2" })),
    ev(6, events.toolCompleted({ runId: "r1", callId: "c0", name: "read", result: "result-0" })),
    ev(7, events.toolCompleted({ runId: "r1", callId: "c1", name: "read", result: "result-1" })),
    ev(8, events.assistantCompleted({ runId: "r1", text: "done" })),
  ];

  const tools = toTranscript(log).filter((m) => m.kind === "tool");
  // Cards render in call order (the order tool.started arrived), each marked done...
  assert.deepEqual(
    tools.map((t) => ({ id: t.id, result: t.result, done: t.done })),
    [
      { id: "c0", result: "result-0", done: true },
      { id: "c1", result: "result-1", done: true },
      { id: "c2", result: "result-2", done: true },
    ],
  );
});

test("M2: a context.compacted fold leaves the rendered transcript full (no collapse)", () => {
  // Compaction shapes only the host prompt projection; the durable log + UI transcript keep the
  // full history (D-042). So a fold event in the log must not collapse or drop any turn - and it
  // leaves no lingering marker (the live progress bar is transient; see the M5 tests below).
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.userMessage({ text: "goal", provider: "qwen" })),
    ev(3, events.assistantCompleted({ runId: "r1", text: "did the early work" })),
    ev(
      4,
      events.contextCompacted({
        foldId: "f1",
        throughSeq: 3,
        summary: "early work done",
        manifest: { turnRange: { fromSeq: 1, toSeq: 3 }, files: [], tools: [], topics: [] },
        tokensBefore: 50_000,
        tokensAfter: 20_000,
        model: "qwen",
      }),
    ),
    ev(5, events.userMessage({ text: "continue", provider: "qwen" })),
    ev(6, events.assistantCompleted({ runId: "r2", text: "kept going" })),
  ];

  const messages = toTranscript(log);
  // Every turn from before AND after the fold is still rendered, in full.
  assert.deepEqual(
    messages.filter((m) => m.kind === "user").map((m) => m.text),
    ["goal", "continue"],
  );
  assert.deepEqual(
    messages.filter((m) => m.kind === "assistant").map((m) => m.text),
    ["did the early work", "kept going"],
  );
});

test("legacy stepLimit events render as legacy budget stops without typed stop data", () => {
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "best effort", stepLimit: 32 })),
  ];
  const [message] = toTranscript(log).filter((m) => m.kind === "assistant");
  assert.equal(message?.kind === "assistant" && message.stepLimit, 32);
  assert.equal(message?.kind === "assistant" && message.stop, undefined);
});

test("typed stop causes survive transcript replay", () => {
  const stop = {
    cause: "step_backstop",
    action: "paused" as const,
    summary: "Paused at the 32-step backstop before context pressure.",
    steps: 32,
    context: { inputTokens: 89_022, contextWindow: 1_000_000, pressure: 0.089022 },
  };
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "", stepLimit: 32, stop })),
  ];
  const [message] = toTranscript(log).filter((m) => m.kind === "assistant");
  assert.equal(message?.kind === "assistant" && message.stepLimit, 32);
  assert.deepEqual(message?.kind === "assistant" && message.stop, stop);
});

const compacted = (foldId: string, seq: number) =>
  ev(
    seq,
    events.contextCompacted({
      foldId,
      throughSeq: seq - 1,
      summary: "folded",
      manifest: { turnRange: { fromSeq: 1, toSeq: seq - 1 }, files: [], tools: [], topics: [] },
      tokensBefore: 52_000,
      tokensAfter: 24_000,
      model: "qwen",
    }),
  );

test("M5: a streaming fold shows a live progress bar that advances as tokens stream", () => {
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "done" })),
    ev(3, events.contextCompacting({ foldId: "f1", tokens: 120, budget: 1_000 })),
    ev(4, events.contextCompacting({ foldId: "f1", tokens: 480, budget: 1_000 })),
  ];

  const bar = toTranscript(log).find((m) => m.kind === "compacting");
  assert.ok(bar, "a progress bar is shown while the fold streams");
  assert.equal(bar?.kind === "compacting" && bar.tokens, 480, "it advances to the latest tick");
  assert.equal(bar?.kind === "compacting" && bar.budget, 1_000);
});

test("M5: the progress bar VANISHES when the fold completes (context.compacted)", () => {
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "done" })),
    ev(3, events.contextCompacting({ foldId: "f1", tokens: 480, budget: 1_000 })),
    compacted("f1", 4),
  ];

  const messages = toTranscript(log);
  assert.ok(
    !messages.some((m) => m.kind === "compacting"),
    "the bar is gone once the fold is done",
  );
  // The conversation turns are untouched - compaction leaves no lingering marker, just the fold.
  assert.deepEqual(
    messages.filter((m) => m.kind === "assistant").map((m) => m.text),
    ["done"],
  );
});

test("M5: a late compacting tick after completion never re-spawns the bar", () => {
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "done" })),
    ev(3, events.contextCompacting({ foldId: "f1", tokens: 480, budget: 1_000 })),
    compacted("f1", 4),
    // A straggler advisory tick arriving after the fold finished (fire-and-forget reordering).
    ev(5, events.contextCompacting({ foldId: "f1", tokens: 600, budget: 1_000 })),
  ];
  assert.ok(!toTranscript(log).some((m) => m.kind === "compacting"), "stays vanished");
});

test("M5: a /compact that FAILS (host restart mid-fold) reaps the orphaned compacting bar", () => {
  // The host restarted mid-fold, so no context.compacted ever lands - the only signal the fold
  // ended is the /compact command.result. Without reaping there, the transient bar would linger and
  // keep animating ABOVE the "Compaction interrupted" message (the reported bug).
  const log = [
    ev(1, events.userCommand({ command: "/compact", args: "" })),
    ev(2, events.contextCompacting({ foldId: "f1", tokens: 200, budget: 1_000 })),
    ev(3, events.contextCompacting({ foldId: "f1", tokens: 480, budget: 1_000 })),
    // ...host restarts; no context.compacted. The dangling /compact gets a failed result:
    ev(
      4,
      events.commandResult({
        command: "/compact",
        text: "Compaction interrupted — the host restarted. Run /compact again.",
        ok: false,
      }),
    ),
  ];
  const messages = toTranscript(log);
  assert.ok(
    !messages.some((m) => m.kind === "compacting"),
    "the orphaned bar is reaped when /compact reports failure",
  );
  assert.ok(
    messages.some((m) => m.kind === "result" && !m.ok),
    "the failed result is still rendered",
  );
});

test("a non-/compact command result does NOT reap a live fold bar", () => {
  // Commands run off the one-turn gate, so a /doctor result can land WHILE a fold streams; it must
  // not kill the live compacting bar.
  const log = [
    ev(1, events.userCommand({ command: "/doctor", args: "" })),
    ev(2, events.contextCompacting({ foldId: "f1", tokens: 200, budget: 1_000 })),
    ev(3, events.commandResult({ command: "/doctor", text: "all good", ok: true })),
  ];
  assert.ok(
    toTranscript(log).some((m) => m.kind === "compacting"),
    "an unrelated command result leaves the live fold bar alone",
  );
});

test("M5: an orphaned fold bar (no context.compacted) is reaped when the next turn starts", () => {
  // A fold began streaming (its bar appeared) but the host was reset before context.compacted - the
  // bar would otherwise linger forever, stuck at whatever % it reached. The next turn reaps it.
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "done" })),
    ev(3, events.contextCompacting({ foldId: "orphan", tokens: 530, budget: 1_000 })),
    // ...host reset mid-fold; no context.compacted ever lands. A later turn begins:
    ev(4, events.assistantStarted({ runId: "r2", model: "qwen", provider: "qwen", warm: true })),
    ev(5, events.assistantCompleted({ runId: "r2", text: "next" })),
  ];
  assert.ok(!toTranscript(log).some((m) => m.kind === "compacting"), "the orphan bar is reaped");
});

test("M5: a fresh fold shows one bar at the tail, never a second beside an orphan (singleton)", () => {
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "done" })),
    // An orphaned fold from a prior mid-fold reset, stuck mid-stream (no context.compacted).
    ev(3, events.contextCompacting({ foldId: "orphan", tokens: 530, budget: 1_000 })),
    // A fresh /compact starts a new fold.
    ev(4, events.userCommand({ command: "/compact", args: "" })),
    ev(5, events.contextCompacting({ foldId: "fresh", tokens: 240, budget: 1_000 })),
  ];
  const messages = toTranscript(log);
  const bars = messages.filter((m) => m.kind === "compacting");
  assert.equal(bars.length, 1, "only one bar on screen");
  assert.equal(
    bars[0]?.kind === "compacting" && bars[0].foldId,
    "fresh",
    "and it's the fresh fold",
  );
  assert.equal(
    messages.at(-1)?.kind,
    "compacting",
    "the live bar sits at the tail, not in old history",
  );
});

test("panelModel: the ctx meter previews the post-fold size once a fold lands (no turn since)", () => {
  // Compaction runs no turn, so without this the ctx meter would show the stale last-request size.
  // The meter drops to the fold's tokensAfter estimate - the visible proof the context shrank.
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "done", usage, breakdown })),
    compacted("f1", 3), // tokensAfter: 24_000
  ];
  const panel = panelModel(toTranscript(log), log, { replayed: true });
  assert.equal(panel.ctxUsed, 24_000, "the meter previews the fold's post-size estimate");
  assert.equal(panel.ctxMax, usage.contextWindow, "the window is unchanged");
  // The Request treemap stays the last actual request until the next turn measures the new prompt.
  assert.equal(
    panel.totalTokens,
    usage.input + usage.output,
    "the Request total stays the last call",
  );
  assert.deepEqual(panel.breakdown, breakdown, "no faked per-category split");
});

test("D-046: a delegation reduces its running + done links to one block with the result", () => {
  const log = [
    ev(1, events.userMessage({ text: "find the bug", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(
      3,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "sess::sub::abc",
        agent: "explorer",
        task: "search for the failing assertion",
        mode: "inline",
        status: "running",
      }),
    ),
    ev(
      4,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "sess::sub::abc",
        agent: "explorer",
        task: "search for the failing assertion",
        mode: "inline",
        status: "done",
        result: "the bug is in src/auth.ts:42",
      }),
    ),
    ev(5, events.assistantCompleted({ runId: "r1", text: "Fixed it." })),
  ];
  const messages = toTranscript(log);
  const blocks = messages.filter(
    (m): m is Extract<Message, { kind: "delegation" }> => m.kind === "delegation",
  );
  assert.equal(blocks.length, 1, "the running + done links collapse to one linked block");
  assert.equal(blocks[0]?.status, "done", "the block advances to the terminal status in place");
  assert.equal(blocks[0]?.agent, "explorer");
  assert.equal(
    blocks[0]?.result,
    "the bug is in src/auth.ts:42",
    "it carries the distilled result",
  );
});

test("D-048: a background delegation's late result lands by id AFTER the parent turn completes", () => {
  const log = [
    ev(1, events.userMessage({ text: "audit the repo", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    // The parent kicks off a background child and finishes its own turn FIRST (running link only).
    ev(
      3,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "sess::sub::bg",
        agent: "explorer",
        task: "scan for TODOs",
        mode: "background",
        status: "running",
      }),
    ),
    ev(4, events.assistantCompleted({ runId: "r1", text: "Working on it in the background." })),
    // The child's result arrives LATER (higher seq, after the completion) - it must still land on the
    // same block by childSessionId, wire-order tolerant (like D-050 / M4).
    ev(
      5,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "sess::sub::bg",
        agent: "explorer",
        task: "scan for TODOs",
        mode: "background",
        status: "done",
        result: "found 3 TODOs",
      }),
    ),
  ];
  const blocks = toTranscript(log).filter(
    (m): m is Extract<Message, { kind: "delegation" }> => m.kind === "delegation",
  );
  assert.equal(
    blocks.length,
    1,
    "the late done link advances the existing block, not a second one",
  );
  assert.equal(blocks[0]?.mode, "background");
  assert.equal(blocks[0]?.status, "done", "the late result advances the block to done");
  assert.equal(blocks[0]?.result, "found 3 TODOs", "the late distilled result lands by id");
});

test("D-079: an assistant.reconnecting event renders an inline reconnecting marker", () => {
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(3, events.assistantReconnecting({ runId: "r1", attempt: 2, detail: "websocket closed" })),
    ev(4, events.assistantDelta({ runId: "r1", text: "recovered answer" })),
    ev(5, events.assistantCompleted({ runId: "r1", text: "recovered answer" })),
  ];
  const messages = toTranscript(log);
  const marker = messages.find(
    (m): m is Extract<Message, { kind: "reconnecting" }> => m.kind === "reconnecting",
  );
  assert.ok(marker, "a reconnecting marker is rendered");
  assert.equal(marker.attempt, 2);
  assert.match(marker.detail, /websocket/);
  // The post-reconnect answer still renders as its own assistant segment below the marker.
  assert.ok(
    messages.some((m) => m.kind === "assistant" && m.text.includes("recovered answer")),
    "the reconnected answer streams after the marker",
  );
});

test("a host-reaped orphan is marked interrupted, not cancelled (host restart is not a user ESC)", () => {
  // reapOrphans closes a turn left dangling by a host restart/crash with interrupted:true - it must
  // NOT render as the red user "cancelled", so a hot-reload never looks like the user pressed ESC.
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "", interrupted: true })),
  ];
  const segment = toTranscript(log).find((m) => m.kind === "assistant");
  assert.equal(segment?.kind === "assistant" && segment.interrupted, true, "marked interrupted");
  assert.equal(segment?.kind === "assistant" && Boolean(segment.cancelled), false, "not cancelled");
});

test("a cancelled turn keeps the context it reached (panel survives cancel)", () => {
  // The cancel completion carries no usage/breakdown; without the progress fallback the panel would
  // blank to "No call data yet". The segment must inherit the run's last assistant.progress snapshot.
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.assistantProgress({ runId: "r1", usage, breakdown })),
    ev(3, events.assistantCompleted({ runId: "r1", text: "", cancelled: true })),
  ];
  const panel = panelModel(toTranscript(log), log, { replayed: true });
  assert.equal(panel.ctxUsed, usage.input, "the ctx meter keeps the cancelled turn's input");
  assert.equal(panel.ctxMax, usage.contextWindow, "the window survives");
  assert.deepEqual(panel.breakdown, breakdown, "the Request treemap survives the cancel");
});

const toolMsg = (id: string, name: string): Message => ({
  kind: "tool",
  id,
  name,
  args: "{}",
  done: true,
});
const asstMsg = (id: string): Message => ({
  kind: "assistant",
  id,
  runId: "r",
  text: "x",
  thinking: "",
  done: true,
  warm: false,
  model: "m",
});

test("readOnlyToolBatches groups 2+ consecutive read-only tools and skips the continuations", () => {
  const { batchAt, skip } = readOnlyToolBatches([
    toolMsg("a", "read"),
    toolMsg("b", "grep"),
    toolMsg("c", "glob"),
  ]);
  assert.deepEqual([...batchAt.keys()], ["a"], "batch keyed at the first row");
  assert.equal(batchAt.get("a")?.length, 3, "all three reads in the batch");
  assert.deepEqual([...skip].sort(), ["b", "c"], "the continuations are skipped");
});

test("a lone read-only tool is not a batch", () => {
  const { batchAt, skip } = readOnlyToolBatches([toolMsg("a", "read")]);
  assert.equal(batchAt.size, 0);
  assert.equal(skip.size, 0);
});

test("a mutating tool or an assistant segment breaks the concurrent run", () => {
  // edit (mutating, a barrier) splits two reads into two non-batches.
  assert.equal(
    readOnlyToolBatches([toolMsg("a", "read"), toolMsg("e", "edit"), toolMsg("b", "read")]).batchAt
      .size,
    0,
  );
  // an assistant segment between reads (a step boundary) breaks the run too.
  assert.equal(
    readOnlyToolBatches([toolMsg("a", "read"), asstMsg("s"), toolMsg("b", "read")]).batchAt.size,
    0,
  );
  // two reads, a barrier, then two reads = two separate batches.
  const split = readOnlyToolBatches([
    toolMsg("a", "read"),
    toolMsg("b", "glob"),
    toolMsg("e", "edit"),
    toolMsg("c", "read"),
    toolMsg("d", "grep"),
  ]);
  assert.deepEqual([...split.batchAt.keys()].sort(), ["a", "c"]);
});

test("panelModel suppresses partial replay progress snapshots", () => {
  const replaySlice = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.assistantProgress({ runId: "r1", usage, breakdown })),
  ];

  assert.deepEqual(panelModel(toTranscript(replaySlice), replaySlice, { replayed: false }), {});
});

test("panelModel uses progress snapshots after replay completes", () => {
  const replayedEvents = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.assistantProgress({ runId: "r1", usage, breakdown })),
  ];

  const panel = panelModel(toTranscript(replayedEvents), replayedEvents, { replayed: true });

  assert.equal(panel.ctxUsed, usage.input);
  assert.equal(panel.ctxMax, usage.contextWindow);
  assert.equal(panel.totalTokens, usage.input + usage.output);
  assert.deepEqual(panel.breakdown, breakdown);
});

test("panelModel folds the in-flight turn into Session, so Session updates live (not only on completion)", () => {
  const liveOnly = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.assistantProgress({ runId: "r1", usage, breakdown })),
  ];
  const panel = panelModel(toTranscript(liveOnly), liveOnly, { replayed: true });
  // The running turn is the whole session so far, so Session mirrors the live turn instead of being
  // empty until the turn completes.
  assert.deepEqual(
    panel.contextBreakdown,
    breakdown,
    "Session includes the in-flight turn's breakdown",
  );
  assert.equal(panel.contextTokens, panel.totalTokens, "Session tokens include the in-flight turn");
});

test("panelModel floors ctx usage at the request breakdown estimate", () => {
  const lowUsage = {
    input: 756,
    output: 21_266,
    contextWindow: 1_000_000,
    genMs: 1_000,
  };
  const deepseekBreakdown: UsageBreakdown = {
    input: {
      systemAndTools: 30_000,
      userText: 20,
      assistantText: 0,
      toolCallArgs: 0,
      toolResults: 260_000,
      imagesBase64: 0,
      imageCount: 0,
      byTool: { read: 260_000 },
    },
    output: { thinking: 70_000, answer: 1_000, toolCallArgs: 0 },
  };
  const log = [
    ev(
      1,
      events.assistantStarted({ runId: "r1", model: "deepseek", provider: "deepseek", warm: true }),
    ),
    ev(2, events.assistantProgress({ runId: "r1", usage: lowUsage, breakdown: deepseekBreakdown })),
  ];
  const expectedInput = Math.round((30_000 + 20 + 260_000) / 4);

  const panel = panelModel(toTranscript(log), log, { replayed: true });

  assert.equal(panel.ctxUsed, expectedInput);
  assert.equal(panel.ctxMax, lowUsage.contextWindow);
  assert.equal(panel.totalTokens, expectedInput + lowUsage.output);
  assert.deepEqual(panel.breakdown, deepseekBreakdown);

  const completedLog = [
    ...log,
    ev(
      3,
      events.assistantCompleted({
        runId: "r1",
        text: "done",
        usage: lowUsage,
        breakdown: deepseekBreakdown,
      }),
    ),
  ];
  const completedPanel = panelModel(toTranscript(completedLog), completedLog, { replayed: true });
  assert.equal(completedPanel.contextTokens, expectedInput + lowUsage.output);
});

test("D-082: user.shell + shell.result reduce to one shell block (pending -> done)", () => {
  const pending = toTranscript([
    ev(1, events.userShell({ requestId: "rq1", command: "printf hello" })),
  ]);
  assert.equal(pending.length, 1);
  const block = pending[0];
  assert.equal(block?.kind, "shell");
  if (block?.kind !== "shell") return;
  assert.equal(block.command, "printf hello");
  assert.equal(block.done, false);
  assert.equal(block.output, undefined);

  // The result fills the SAME block in place (keyed by requestId), never a second card.
  const done = toTranscript([
    ev(1, events.userShell({ requestId: "rq1", command: "printf hello" })),
    ev(
      2,
      events.shellResult({ requestId: "rq1", command: "printf hello", output: "hello", ok: true }),
    ),
  ]);
  assert.equal(done.length, 1);
  const filled = done[0];
  assert.equal(filled?.kind, "shell");
  if (filled?.kind !== "shell") return;
  assert.equal(filled.done, true);
  assert.equal(filled.output, "hello");
  assert.equal(filled.ok, true);
});

test("D-082: a refused/failed shell command renders ok:false", () => {
  const messages = toTranscript([
    ev(1, events.userShell({ requestId: "rq1", command: "rm -rf /" })),
    ev(
      2,
      events.shellResult({
        requestId: "rq1",
        command: "rm -rf /",
        output: "refused: blocked",
        ok: false,
      }),
    ),
  ]);
  const block = messages[0];
  assert.equal(block?.kind, "shell");
  if (block?.kind !== "shell") return;
  assert.equal(block.ok, false);
  assert.equal(block.output, "refused: blocked");
});

test("D-082: a shell.result with no prior request still renders from its own command", () => {
  const messages = toTranscript([
    ev(1, events.shellResult({ requestId: "orphan", command: "ls", output: "a\nb", ok: true })),
  ]);
  assert.equal(messages.length, 1);
  const block = messages[0];
  assert.equal(block?.kind, "shell");
  if (block?.kind !== "shell") return;
  assert.equal(block.command, "ls");
  assert.equal(block.done, true);
  assert.equal(block.output, "a\nb");
});

test("D-082: /clear resets shell blocks like the rest of the transcript", () => {
  const messages = toTranscript([
    ev(1, events.userShell({ requestId: "rq1", command: "ls" })),
    ev(2, events.shellResult({ requestId: "rq1", command: "ls", output: "x", ok: true })),
    ev(3, events.userCommand({ command: "/clear", args: "" })),
    ev(4, events.userShell({ requestId: "rq2", command: "pwd" })),
  ]);
  // Only the post-clear shell block survives (the pre-clear pair is dropped, and its requestId is
  // free again so a later result would re-pair cleanly).
  assert.equal(messages.length, 1);
  const block = messages[0];
  assert.equal(block?.kind, "shell");
  if (block?.kind !== "shell") return;
  assert.equal(block.command, "pwd");
});

test("/clear renders nothing - neither the command echo nor its 'cleared' result", () => {
  const messages = toTranscript([
    ev(1, events.userMessage({ text: "hi", provider: "qwen" })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "hello" })),
    ev(3, events.userCommand({ command: "/clear", args: "" })),
    ev(
      4,
      events.commandResult({
        command: "/clear",
        text: "✓ started fresh session trevor-20260626-123456z-abcdef12",
        ok: true,
      }),
    ),
  ]);
  // The pre-clear turn is reset by the user.command, and the /clear result is swallowed - empty view.
  assert.deepEqual(messages, []);
});

test("/clear failure result remains visible after the transcript reset", () => {
  const messages = toTranscript([
    ev(1, events.userMessage({ text: "hi", provider: "qwen" })),
    ev(2, events.userCommand({ command: "/clear", args: "" })),
    ev(
      3,
      events.commandResult({
        command: "/clear",
        text: "Failed to start a fresh session: spawn failed",
        ok: false,
      }),
    ),
  ]);
  assert.equal(messages.length, 1);
  const result = messages[0];
  assert.equal(result?.kind, "result");
  if (result?.kind !== "result") return;
  assert.equal(result.ok, false);
  assert.match(result.text, /spawn failed/);
});
