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
