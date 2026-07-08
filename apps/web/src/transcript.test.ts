import assert from "node:assert/strict";
import {
  events,
  type SessionEvent,
  type TrevorEventInput,
  type UsageBreakdown,
} from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { test } from "vitest";
import {
  formatLimitScope,
  limitMarkerSummary,
  type Message,
  panelModel,
  readOnlyToolBatches,
  toTranscript,
} from "./transcript";

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

const ev = (seq: number, input: TrevorEventInput): SessionEvent =>
  storedEvent(input, { seq, producerId: "trevor-host", createdAt: "2026-06-24T00:00:00.000Z" });

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

test("09.1 M3: model.switched folds into a modelSwitch marker between the before/after assistant output", () => {
  const log = [
    ev(
      1,
      events.assistantStarted({
        runId: "r1",
        model: "deepseek-v4",
        provider: "deepseek",
        warm: true,
      }),
    ),
    ev(2, events.assistantDelta({ runId: "r1", text: "thinking low..." })),
    ev(
      3,
      events.modelSwitched({
        runId: "r1",
        from: { model: "deepseek-v4", reasoning: "low" },
        to: { model: "deepseek-v4", reasoning: "high" },
        initiator: "manual",
        outcome: "applied",
      }),
    ),
    ev(4, events.assistantDelta({ runId: "r1", text: "now high." })),
    ev(5, events.assistantCompleted({ runId: "r1", text: "thinking low...now high." })),
  ];
  const messages = toTranscript(log);
  const marker = messages.find((m) => m.kind === "modelSwitch");
  assert.ok(marker, "a modelSwitch marker is folded from model.switched");
  assert.equal(marker?.kind === "modelSwitch" && marker.outcome, "applied");
  assert.equal(marker?.kind === "modelSwitch" && marker.from.reasoning, "low");
  assert.equal(marker?.kind === "modelSwitch" && marker.to.reasoning, "high");
  assert.equal(marker?.kind === "modelSwitch" && marker.from.model, "deepseek-v4");
  // The switch finalizes the open assistant segment, so the post-switch output is a fresh segment below
  // the marker (two assistant blocks split by the breadcrumb), not one merged block.
  const order = messages.map((m) => m.kind);
  const assistants = order.filter((k) => k === "assistant").length;
  assert.equal(assistants, 2, "the marker splits the turn into before/after assistant segments");
  assert.ok(
    order.indexOf("modelSwitch") > order.indexOf("assistant"),
    "the marker sits after the first assistant segment",
  );
});

test("44.4: assistant.limit folds into a limit marker carrying provider/status/scope/reset", () => {
  const log = [
    ev(
      1,
      events.assistantStarted({ runId: "r1", model: "opus", provider: "anthropic", warm: true }),
    ),
    ev(
      2,
      events.assistantLimit({
        provider: "anthropic",
        status: "approaching",
        scope: "five_hour",
        resetsAt: 1_780_000_000,
        utilization: 0.9,
      }),
    ),
    ev(3, events.assistantDelta({ runId: "r1", text: "still going" })),
    ev(4, events.assistantCompleted({ runId: "r1", text: "still going" })),
  ];
  const marker = toTranscript(log).find((m) => m.kind === "limit");
  assert.ok(marker, "a limit marker is folded from assistant.limit");
  assert.equal(marker?.kind === "limit" && marker.status, "approaching");
  assert.equal(marker?.kind === "limit" && marker.scope, "five_hour");
  assert.equal(marker?.kind === "limit" && marker.provider, "anthropic");
  assert.equal(marker?.kind === "limit" && marker.resetsAt, 1_780_000_000);
  assert.equal(marker?.kind === "limit" && marker.utilization, 0.9);
});

test("44.4: limitMarkerSummary humanizes provider/window/reset/utilization deterministically", () => {
  const now = Date.parse("2026-07-04T12:00:00.000Z");
  assert.equal(
    limitMarkerSummary(
      {
        kind: "limit",
        id: "l",
        provider: "anthropic",
        status: "approaching",
        scope: "five_hour",
        resetsAt: now / 1000 + 2 * 3600,
        utilization: 0.9,
      },
      now,
    ),
    "anthropic · 5h window · resets in 2h · 90% used",
  );
  // A detect-only reached with no reset/utilization is just provider + window.
  assert.equal(
    limitMarkerSummary(
      { kind: "limit", id: "l", provider: "codex", status: "reached", scope: "unknown" },
      now,
    ),
    "codex · usage",
  );
  assert.equal(formatLimitScope("seven_day_opus"), "7d Opus window");
  assert.equal(formatLimitScope("some_future_window"), "some_future_window");
});

test("09.1 M3: a blocked model.switched carries its reason into the marker", () => {
  const log = [
    ev(
      1,
      events.assistantStarted({ runId: "r1", model: "big", provider: "anthropic", warm: true }),
    ),
    ev(
      2,
      events.modelSwitched({
        runId: "r1",
        from: { model: "big", reasoning: "high" },
        to: { model: "small", reasoning: "high" },
        initiator: "manual",
        outcome: "blocked",
        reason: "conversation does not fit the smaller context window",
      }),
    ),
    ev(3, events.assistantCompleted({ runId: "r1", text: "stayed on big" })),
  ];
  const marker = toTranscript(log).find((m) => m.kind === "modelSwitch");
  assert.equal(marker?.kind === "modelSwitch" && marker.outcome, "blocked");
  assert.match((marker?.kind === "modelSwitch" && marker.reason) || "", /smaller context window/);
});

test("a tool left in flight when the run is cancelled is finalized as aborted, not stuck running", () => {
  // ESC cancels mid-tool: the host publishes assistant.completed{cancelled} and interrupts the fiber,
  // so a concurrently-dispatched read-only tool (session_recall) never gets its own tool.completed.
  // The transcript must finalize it as aborted instead of rendering "recalling…" forever.
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.toolStarted({ runId: "r1", callId: "c0", name: "read", arguments: "{}" })),
    ev(3, events.toolCompleted({ runId: "r1", callId: "c0", name: "read", result: "ok" })),
    ev(
      4,
      events.toolStarted({ runId: "r1", callId: "c1", name: "session_recall", arguments: "{}" }),
    ),
    // No tool.completed for c1 - the user cancels here.
    ev(5, events.assistantCompleted({ runId: "r1", text: "", cancelled: true })),
  ];
  const tools = toTranscript(log).filter((m) => m.kind === "tool");
  assert.deepEqual(
    tools.map((t) => ({ id: t.id, done: t.done, aborted: t.aborted ?? false })),
    [
      { id: "c0", done: true, aborted: false }, // completed normally
      { id: "c1", done: true, aborted: true }, // finalized by the cancel
    ],
  );
});

test("a tool.started that races in AFTER the cancelled completion is aborted on arrival", () => {
  // The cancel publishes the completion FIRST, then the interrupted fiber emits one last tool.started.
  // That late start belongs to an already-terminated run, so it renders aborted (never running).
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "", cancelled: true })),
    ev(
      3,
      events.toolStarted({ runId: "r1", callId: "late", name: "session_recall", arguments: "{}" }),
    ),
  ];
  const tool = toTranscript(log).find((m) => m.kind === "tool");
  assert.equal(tool?.kind === "tool" && tool.done, true);
  assert.equal(tool?.kind === "tool" && tool.aborted, true);
});

test("a normally completed tool is never marked aborted (regression)", () => {
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.toolStarted({ runId: "r1", callId: "c0", name: "read", arguments: "{}" })),
    ev(3, events.toolCompleted({ runId: "r1", callId: "c0", name: "read", result: "ok" })),
    ev(4, events.assistantCompleted({ runId: "r1", text: "done" })),
  ];
  const tool = toTranscript(log).find((m) => m.kind === "tool");
  assert.equal(tool?.kind === "tool" && tool.done, true);
  assert.equal(tool?.kind === "tool" && (tool.aborted ?? false), false);
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
    summary:
      "Paused at the adaptive 96-step budget before context pressure (>=1M context, 8.9% pressure -> 96 steps).",
    steps: 96,
    context: { inputTokens: 89_022, contextWindow: 1_000_000, pressure: 0.089022 },
  };
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "", stepLimit: 96, stop })),
  ];
  const [message] = toTranscript(log).filter((m) => m.kind === "assistant");
  assert.equal(message?.kind === "assistant" && message.stepLimit, 96);
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

test("09.4 M3: an inline delegation reduces its running + mirror + done links to one inlineAgent entry", () => {
  const log = [
    ev(1, events.userMessage({ text: "find the bug", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    // Seed (running, model/reasoning stamped) -> a running token-mirror -> terminal fold-back (M2).
    ev(
      3,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "sess::sub::abc",
        agent: "explorer",
        task: "search for the failing assertion",
        mode: "inline",
        status: "running",
        model: "qwen3-coder",
        reasoningLevel: "high",
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
        status: "running",
        model: "qwen3-coder",
        reasoningLevel: "high",
        tokens: 120,
      }),
    ),
    ev(
      5,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "sess::sub::abc",
        agent: "explorer",
        task: "search for the failing assertion",
        mode: "inline",
        status: "done",
        model: "qwen3-coder",
        reasoningLevel: "high",
        tokens: 340,
      }),
    ),
    ev(6, events.assistantCompleted({ runId: "r1", text: "Fixed it." })),
  ];
  const messages = toTranscript(log);
  const blocks = messages.filter(
    (m): m is Extract<Message, { kind: "inlineAgent" }> => m.kind === "inlineAgent",
  );
  assert.equal(
    blocks.length,
    1,
    "the running + mirror + done links collapse to one inlineAgent block",
  );
  assert.equal(blocks[0]?.agents.length, 1, "one child entry");
  const agent = blocks[0]?.agents[0];
  assert.equal(agent?.status, "done", "advances to the terminal status in place");
  assert.equal(agent?.agent, "explorer");
  assert.equal(agent?.model, "qwen3-coder", "model stamped from the running link (M2)");
  assert.equal(agent?.reasoningLevel, "high", "reasoning stamped from the running link (M2)");
  assert.equal(agent?.tokens, 340, "the latest (terminal) token count wins");
  assert.equal(
    agent?.startedAt,
    Date.parse("2026-06-24T00:00:00.000Z"),
    "startedAt is the running link's own timestamp (no extra wire data)",
  );
  // No background delegation block for an inline child.
  assert.equal(messages.filter((m) => m.kind === "delegation").length, 0);
});

test("09.4 M3: parallel inline children from one parent turn group into one inlineAgent block", () => {
  const log = [
    ev(1, events.userMessage({ text: "audit", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(
      3,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "sess::sub::a",
        agent: "explorer",
        task: "t1",
        mode: "inline",
        status: "running",
      }),
    ),
    ev(
      4,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "sess::sub::b",
        agent: "planner",
        task: "t2",
        mode: "inline",
        status: "running",
      }),
    ),
    ev(
      5,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "sess::sub::a",
        agent: "explorer",
        task: "t1",
        mode: "inline",
        status: "done",
      }),
    ),
    // A second, LATER turn's inline child must NOT join the first turn's group (different parentRunId).
    ev(6, events.assistantStarted({ runId: "r2", warm: true, model: "m", provider: "qwen" })),
    ev(
      7,
      events.delegatedTo({
        runId: "r2",
        childSessionId: "sess::sub::c",
        agent: "reviewer",
        task: "t3",
        mode: "inline",
        status: "running",
      }),
    ),
  ];
  const blocks = toTranscript(log).filter(
    (m): m is Extract<Message, { kind: "inlineAgent" }> => m.kind === "inlineAgent",
  );
  assert.equal(blocks.length, 2, "one block per parent turn (grouped by parentRunId)");
  assert.equal(blocks[0]?.parentRunId, "r1");
  assert.deepEqual(
    blocks[0]?.agents.map((a) => a.agent),
    ["explorer", "planner"],
    "both r1 children in one block, in spawn order",
  );
  assert.equal(
    blocks[0]?.agents.find((a) => a.childSessionId === "sess::sub::a")?.status,
    "done",
    "one child advances in place while its sibling stays running",
  );
  assert.equal(
    blocks[0]?.agents.find((a) => a.childSessionId === "sess::sub::b")?.status,
    "running",
  );
  assert.equal(blocks[1]?.parentRunId, "r2");
  assert.deepEqual(
    blocks[1]?.agents.map((a) => a.agent),
    ["reviewer"],
  );
});

test("09.4 M3: delegate_inline / delegate_background tool calls are suppressed (no tool card)", () => {
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(
      3,
      events.toolStarted({ runId: "r1", callId: "c1", name: "delegate_inline", arguments: "{}" }),
    ),
    ev(
      4,
      events.toolStarted({
        runId: "r1",
        callId: "c2",
        name: "delegate_background",
        arguments: "{}",
      }),
    ),
    ev(
      5,
      events.toolStarted({ runId: "r1", callId: "c3", name: "bash", arguments: '{"cmd":"ls"}' }),
    ),
    ev(6, events.toolCompleted({ runId: "r1", callId: "c3", name: "bash", result: "ok" })),
  ];
  const tools = toTranscript(log).filter(
    (m): m is Extract<Message, { kind: "tool" }> => m.kind === "tool",
  );
  assert.deepEqual(
    tools.map((t) => t.name),
    ["bash"],
    "the delegation tool rows are suppressed; other tools still render",
  );
});

test("task tools act invisibly in the transcript", () => {
  const log = [
    ev(1, events.userMessage({ text: "track the work", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(3, events.assistantDelta({ runId: "r1", text: "before " })),
    ev(
      4,
      events.toolStarted({
        runId: "r1",
        callId: "create",
        name: "task_create",
        arguments: '{"title":"Do it"}',
      }),
    ),
    ev(
      5,
      events.toolCompleted({
        runId: "r1",
        callId: "create",
        name: "task_create",
        result: "created",
      }),
    ),
    ev(
      6,
      events.toolStarted({
        runId: "r1",
        callId: "update",
        name: "task_update",
        arguments: '{"id":"t1","status":"done"}',
      }),
    ),
    ev(
      7,
      events.toolCompleted({
        runId: "r1",
        callId: "update",
        name: "task_update",
        result: "updated",
      }),
    ),
    ev(8, events.toolStarted({ runId: "r1", callId: "list", name: "task_list", arguments: "{}" })),
    ev(
      9,
      events.toolCompleted({
        runId: "r1",
        callId: "list",
        name: "task_list",
        result: "1 task",
      }),
    ),
    ev(10, events.assistantDelta({ runId: "r1", text: "after" })),
    ev(11, events.assistantCompleted({ runId: "r1", text: "before after" })),
  ];
  const messages = toTranscript(log);

  assert.equal(
    messages.some((m) => m.kind === "tool"),
    false,
  );
  assert.deepEqual(
    messages.map((m) => m.kind),
    ["user", "assistant"],
  );
  const assistant = messages.find((m) => m.kind === "assistant");
  assert.equal(assistant?.kind === "assistant" && assistant.text, "before after");
});

test("09.4: a workflow-leaf inline delegation stays a delegation block, NOT an inlineAgent row", () => {
  // Workflow leaves reuse mode:"inline" but have their own rendering, so isInlineAgentDelegation
  // excludes them: they must keep the delegation block, not become an inline-agent row.
  const log = [
    ev(1, events.userMessage({ text: "run the workflow", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(
      3,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "s::leaf::a",
        agent: "workflow-leaf",
        task: "leaf work",
        mode: "inline",
        status: "running",
      }),
    ),
  ];
  const messages = toTranscript(log);
  assert.equal(
    messages.filter((m) => m.kind === "inlineAgent").length,
    0,
    "a workflow leaf is NOT projected as an inline-agent row",
  );
  const blocks = messages.filter(
    (m): m is Extract<Message, { kind: "delegation" }> => m.kind === "delegation",
  );
  assert.equal(blocks.length, 1, "it keeps its delegation block");
  assert.equal(blocks[0]?.agent, "workflow-leaf");
});

test("09.4 M2/M3: a late running token-mirror after the terminal fold-back does not regress the row", () => {
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(
      3,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "s::sub::a",
        agent: "explorer",
        task: "t",
        mode: "inline",
        status: "running",
      }),
    ),
    // The terminal fold-back lands (done)...
    ev(
      4,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "s::sub::a",
        agent: "explorer",
        task: "t",
        mode: "inline",
        status: "done",
        tokens: 500,
      }),
    ),
    // ...then a straggler fire-and-forget running mirror arrives out of order (higher seq).
    ev(
      5,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "s::sub::a",
        agent: "explorer",
        task: "t",
        mode: "inline",
        status: "running",
        tokens: 400,
      }),
    ),
  ];
  const block = toTranscript(log).find(
    (m): m is Extract<Message, { kind: "inlineAgent" }> => m.kind === "inlineAgent",
  );
  assert.equal(
    block?.agents[0]?.status,
    "done",
    "a late running mirror never regresses a terminal entry",
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

test("D-002: a later delegated.to{interrupted} advances the existing block in place, no second card", () => {
  const log = [
    ev(1, events.userMessage({ text: "audit the repo", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(
      3,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "sess::sub::orphan",
        agent: "explorer",
        task: "scan for TODOs",
        mode: "background",
        status: "running",
      }),
    ),
    ev(4, events.assistantCompleted({ runId: "r1", text: "Started it in the background." })),
    // The leader died before fold-back; orphan recovery closes the child as interrupted (not failed).
    ev(
      5,
      events.delegatedTo({
        runId: "r1",
        childSessionId: "sess::sub::orphan",
        agent: "explorer",
        task: "scan for TODOs",
        mode: "background",
        status: "interrupted",
        result: "No host was connected to finish this subagent; recovered.",
      }),
    ),
  ];
  const blocks = toTranscript(log).filter(
    (m): m is Extract<Message, { kind: "delegation" }> => m.kind === "delegation",
  );
  assert.equal(
    blocks.length,
    1,
    "the interrupted link advances the existing block, not a second card",
  );
  assert.equal(
    blocks[0]?.status,
    "interrupted",
    "the block advances to the interrupted terminal status",
  );
  assert.equal(blocks[0]?.result, "No host was connected to finish this subagent; recovered.");
});

test("M5: a host reap AND a browser reconcile for the same child converge on ONE interrupted card", () => {
  // The leader died mid-delegation (running link, no fold-back). BOTH recovery paths then fire: the new
  // leader's `reapOrphanSubagents` and a browser's `reconcileSubagent`, each publishing a terminal
  // interrupted link keyed by the same childSessionId. The reducer advances the one block in place, so
  // the two idempotent-by-key links collapse onto a single card - never a duplicate.
  const runningLink = events.delegatedTo({
    runId: "r1",
    childSessionId: "sess::sub::bg",
    agent: "explorer",
    task: "scan for TODOs",
    mode: "background",
    status: "running",
  });
  const interruptedLink = (result: string) =>
    events.delegatedTo({
      runId: "r1",
      childSessionId: "sess::sub::bg",
      agent: "explorer",
      task: "scan for TODOs",
      mode: "background",
      status: "interrupted",
      result,
    });
  const log = [
    ev(1, events.userMessage({ text: "audit the repo", provider: "qwen" })),
    ev(2, events.assistantCompleted({ runId: "r1", text: "started it in the background" })),
    ev(3, runningLink),
    ev(4, interruptedLink("a new leader recovered it")), // host reap
    ev(5, interruptedLink("the browser recovered it")), // browser reconcile (also observed the gap)
  ];
  const blocks = toTranscript(log).filter(
    (m): m is Extract<Message, { kind: "delegation" }> => m.kind === "delegation",
  );
  assert.equal(blocks.length, 1, "both interrupted links converge on one card, not two");
  assert.equal(blocks[0]?.status, "interrupted");
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
  assert.equal(marker.maxAttempts, undefined, "no threaded budget on this pre-02.15-style event");
  assert.match(marker.detail, /websocket/);
  // The post-reconnect answer still renders as its own assistant segment below the marker.
  assert.ok(
    messages.some((m) => m.kind === "assistant" && m.text.includes("recovered answer")),
    "the reconnected answer streams after the marker",
  );
});

test("02.17: an assistant.continued event renders a quiet checkpoint breadcrumb", () => {
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(
      3,
      events.assistantContinued({
        runId: "r1",
        steps: 64,
        pressure: 0.207,
        threshold: 128,
        detail: "continued at step 64 - 20.7% context, room left",
      }),
    ),
    ev(4, events.assistantDelta({ runId: "r1", text: "more work after the checkpoint" })),
    ev(5, events.assistantCompleted({ runId: "r1", text: "more work after the checkpoint" })),
  ];
  const messages = toTranscript(log);
  const breadcrumb = messages.find(
    (m): m is Extract<Message, { kind: "continued" }> => m.kind === "continued",
  );
  assert.ok(breadcrumb, "a continued breadcrumb is projected");
  assert.equal(breadcrumb.steps, 64);
  assert.equal(breadcrumb.pressure, 0.207);
  // It is a NON-terminating marker: the turn still completes normally with its answer below.
  assert.ok(
    messages.some(
      (m) => m.kind === "assistant" && m.text.includes("more work after the checkpoint"),
    ),
    "the continued output streams after the breadcrumb",
  );
  // The completion carries no step_backstop stop - the loop continued, it did not pause.
  const completed = messages.find((m) => m.kind === "assistant" && m.done);
  assert.equal(completed?.kind === "assistant" ? completed.stop : "x", undefined);
});

test("02.15: a reconnecting marker carries the threaded maxAttempts denominator", () => {
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(
      3,
      events.assistantReconnecting({
        runId: "r1",
        attempt: 2,
        maxAttempts: 10,
        detail: "websocket closed",
      }),
    ),
  ];
  const marker = toTranscript(log).find(
    (m): m is Extract<Message, { kind: "reconnecting" }> => m.kind === "reconnecting",
  );
  assert.equal(marker?.attempt, 2);
  assert.equal(marker?.maxAttempts, 10, "the row renders attempt 2/10, not a hardcoded /3");
});

test("58.1 M1: same-run reconnect attempts update one stable marker and keep recovered output below", () => {
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(
      3,
      events.assistantReconnecting({
        runId: "r1",
        attempt: 1,
        maxAttempts: 10,
        detail: "first websocket close",
      }),
    ),
    ev(
      4,
      events.assistantReconnecting({
        runId: "r1",
        attempt: 2,
        maxAttempts: 10,
        detail: "second websocket close",
      }),
    ),
    ev(5, events.assistantDelta({ runId: "r1", text: "recovered answer" })),
    ev(6, events.assistantCompleted({ runId: "r1", text: "recovered answer" })),
  ];

  const messages = toTranscript(log);
  const reconnecting = messages.filter(
    (m): m is Extract<Message, { kind: "reconnecting" }> => m.kind === "reconnecting",
  );
  assert.equal(reconnecting.length, 1, "same-run reconnect attempts update one marker");
  assert.deepEqual(
    reconnecting.map((m) => ({ id: m.id, attempt: m.attempt, maxAttempts: m.maxAttempts })),
    [{ id: "reconnecting:r1", attempt: 2, maxAttempts: 10 }],
  );
  assert.match(reconnecting[0]?.detail ?? "", /second websocket close/);
  assert.deepEqual(
    messages.map((m) => m.kind),
    ["user", "reconnecting", "assistant"],
    "the recovered answer stays below the single reconnect marker",
  );
});

test("58.1 M2: reconnect markers stay distinct across runs and same-run updates keep first placement", () => {
  const log = [
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.assistantStarted({ runId: "r1", warm: true, model: "m", provider: "qwen" })),
    ev(3, events.assistantReconnecting({ runId: "r1", attempt: 1, detail: "first r1" })),
    ev(4, events.assistantStarted({ runId: "r2", warm: true, model: "m", provider: "qwen" })),
    ev(5, events.assistantReconnecting({ runId: "r2", attempt: 1, detail: "first r2" })),
    ev(6, events.assistantReconnecting({ runId: "r1", attempt: 2, detail: "latest r1" })),
  ];

  const reconnecting = toTranscript(log).filter(
    (m): m is Extract<Message, { kind: "reconnecting" }> => m.kind === "reconnecting",
  );

  assert.deepEqual(
    reconnecting.map((m) => ({ id: m.id, attempt: m.attempt, detail: m.detail })),
    [
      { id: "reconnecting:r1", attempt: 2, detail: "latest r1" },
      { id: "reconnecting:r2", attempt: 1, detail: "first r2" },
    ],
    "a later r1 retry updates the first r1 marker without moving it below r2",
  );
  assert.equal(reconnecting[0]?.maxAttempts, undefined, "legacy reconnects keep no maxAttempts");
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

test("/clear is a FULL reset: stale fold/question/tool state never bleeds past it", () => {
  const messages = toTranscript([
    // A turn with a still-open compaction fold, a resolved ask_user, and an open tool, then /clear.
    ev(1, events.userMessage({ text: "go", provider: "qwen" })),
    ev(2, events.contextCompacting({ foldId: "f1", tokens: 480, budget: 1_000 })),
    ...askUserLifecycle(
      "q1",
      qContract(qItem("db", "Which database?")),
      { action: "accept", answer: "Postgres", questions: [{ id: "db", answer: "Postgres" }] },
      "answered",
      "Answered: Postgres",
      3,
    ),
    ev(9, events.toolStarted({ runId: "r", callId: "open", name: "read", arguments: "{}" })),
    ev(10, events.userCommand({ command: "/clear", args: "" })),
    // A fresh turn after the clear: it must render in isolation, with no resurrected fold bar,
    // question item, or tool row from before the reset.
    ev(11, events.userMessage({ text: "fresh start", provider: "qwen" })),
    ev(12, events.assistantCompleted({ runId: "r2", text: "ok" })),
  ]);

  // Only the post-clear user message + its assistant response survive; nothing from before leaks.
  assert.deepEqual(
    messages.map((m) => m.kind),
    ["user", "assistant"],
  );
  const user = messages.find((m) => m.kind === "user");
  assert.equal(user?.kind === "user" ? user.text : null, "fresh start");
  assert.ok(
    !messages.some((m) => m.kind === "question" || m.kind === "compacting"),
    "no stale question item or compaction bar carries past the clear",
  );
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

// --- resolved ask_user folds into a slim "question" transcript item (02.7) ---

const qItem = (id: string, question: string) => ({
  id,
  question,
  answerShape: "free_text" as const,
  multiSelect: false,
  requiresReason: false,
  allowDefer: false,
  choices: [],
});
const qContract = (...questions: ReturnType<typeof qItem>[]) => ({
  schemaVersion: 1 as const,
  questions,
});
const askUserLifecycle = (
  questionId: string,
  contract: ReturnType<typeof qContract>,
  answer: Parameters<typeof events.providerQuestionAnswer>[0]["answer"],
  outcome: "answered" | "declined" | "cancelled" | "expired",
  summary: string,
  base = 1,
) => [
  ev(base, events.toolStarted({ runId: "r", callId: "c", name: "ask_user", arguments: "{}" })),
  ev(
    base + 1,
    events.providerQuestionRequested({
      questionId,
      runId: "r",
      toolCallId: "c",
      toolName: "ask_user",
      adapter: "ask_user",
      contract,
    }),
  ),
  ev(base + 2, events.providerQuestionAnswer({ questionId, answer })),
  ev(
    base + 3,
    events.providerQuestionResolved({
      questionId,
      runId: "r",
      toolCallId: "c",
      outcome,
      summary,
    }),
  ),
  ev(
    base + 4,
    events.toolCompleted({ runId: "r", callId: "c", name: "ask_user", result: outcome }),
  ),
];

test("a resolved ask_user folds into ONE slim question item; the raw tool row stays hidden (02.7)", () => {
  const log = [
    ev(1, events.userMessage({ text: "ask me something", provider: "qwen" })),
    ...askUserLifecycle(
      "a",
      qContract(qItem("db", "Which database?")),
      {
        action: "accept",
        answer: "Postgres",
        questions: [{ id: "db", answer: "Postgres" }],
      },
      "answered",
      "Answered: Postgres",
      2,
    ),
  ];
  const transcript = toTranscript(log);
  // The user message and exactly one semantic question item survive; no raw ask_user tool row.
  assert.deepEqual(
    transcript.map((m) => m.kind),
    ["user", "question"],
  );
  const q = transcript.find((m) => m.kind === "question");
  assert.ok(q && q.kind === "question");
  assert.equal(q.outcome, "answered");
  assert.deepEqual(q.items, [{ id: "db", question: "Which database?", answer: "Postgres" }]);
});

test("declined / cancelled / expired ask_user outcomes each render a question item (02.7)", () => {
  for (const outcome of ["declined", "cancelled", "expired"] as const) {
    const answer =
      outcome === "expired"
        ? ({ action: "accept", answer: "", questions: [] } as const)
        : ({ action: outcome === "declined" ? "decline" : "cancel" } as const);
    const log = askUserLifecycle("a", qContract(qItem("x", "Proceed?")), answer, outcome, outcome);
    const q = toTranscript(log).find((m) => m.kind === "question");
    assert.ok(q && q.kind === "question", outcome);
    assert.equal(q.outcome, outcome);
  }
});

test("a grouped ask_user pairs every question with its answer in order (02.7)", () => {
  const log = askUserLifecycle(
    "g",
    qContract(qItem("db", "Database?"), qItem("orm", "ORM?")),
    {
      action: "accept",
      answer: "Postgres, Drizzle",
      questions: [
        { id: "db", answer: "Postgres" },
        { id: "orm", answer: "Drizzle" },
      ],
    },
    "answered",
    "Answered",
  );
  const q = toTranscript(log).find((m) => m.kind === "question");
  assert.ok(q && q.kind === "question");
  assert.deepEqual(q.items, [
    { id: "db", question: "Database?", answer: "Postgres" },
    { id: "orm", question: "ORM?", answer: "Drizzle" },
  ]);
});

test("a pending (unresolved) ask_user creates NO transcript item (02.7)", () => {
  const log = [
    ev(1, events.toolStarted({ runId: "r", callId: "c", name: "ask_user", arguments: "{}" })),
    ev(
      2,
      events.providerQuestionRequested({
        questionId: "a",
        runId: "r",
        toolCallId: "c",
        toolName: "ask_user",
        adapter: "ask_user",
        contract: qContract(qItem("x", "Which?")),
      }),
    ),
  ];
  assert.deepEqual(
    toTranscript(log).map((m) => m.kind),
    [],
  );
});

test("a duplicate provider.question.resolved updates in place, never a second row (02.7)", () => {
  const log = [
    ...askUserLifecycle(
      "a",
      qContract(qItem("x", "Which?")),
      { action: "accept", answer: "A", questions: [{ id: "x", answer: "A" }] },
      "answered",
      "Answered",
    ),
    // A late/duplicate resolved (replay or reorder) with a different terminal state.
    ev(
      10,
      events.providerQuestionResolved({
        questionId: "a",
        runId: "r",
        toolCallId: "c",
        outcome: "expired",
        summary: "Expired",
      }),
    ),
  ];
  const questions = toTranscript(log).filter((m) => m.kind === "question");
  assert.equal(questions.length, 1, "exactly one question row");
  assert.equal(questions[0]?.kind === "question" && questions[0].outcome, "expired");
});

test("a resolved ask_user with no recorded contract falls back to the resolved summary (02.7)", () => {
  const log = [
    ev(1, events.providerQuestionAnswer({ questionId: "a", answer: { action: "decline" } })),
    ev(
      2,
      events.providerQuestionResolved({
        questionId: "a",
        runId: "r",
        toolCallId: "c",
        outcome: "declined",
        summary: "User declined the question",
      }),
    ),
  ];
  const q = toTranscript(log).find((m) => m.kind === "question");
  assert.ok(q && q.kind === "question");
  assert.deepEqual(q.items, []);
  assert.equal(q.summary, "User declined the question");
});

test("a non-ask_user tool call still renders (the suppression is name-scoped)", () => {
  const log = [
    ev(
      1,
      events.toolStarted({ runId: "r", callId: "c", name: "read", arguments: '{"path":"a.ts"}' }),
    ),
    ev(2, events.toolCompleted({ runId: "r", callId: "c", name: "read", result: "ok" })),
  ];
  const tool = toTranscript(log).find((m) => m.kind === "tool");
  assert.ok(tool && tool.kind === "tool" && tool.name === "read");
});

test("handoff (M2): the target session shows the injected prompt as its first user message", () => {
  // The target log carries handoff provenance (suppressed) + the first user.message (the prompt).
  const log = [
    ev(
      1,
      events.handoffAccepted({
        handoffId: "h1",
        targetSessionId: "tgt",
        prompt: "ship the feature",
      }),
    ),
    ev(2, events.userMessage({ text: "ship the feature", provider: "qwen" })),
  ];
  const transcript = toTranscript(log);
  // Exactly one row: the prompt as a user message. The provenance event renders nothing.
  assert.deepEqual(
    transcript.map((m) => m.kind),
    ["user"],
  );
  const first = transcript[0];
  assert.ok(first && first.kind === "user" && first.text === "ship the feature");
});

test("handoff (M2): the source session shows the command result, never the prompt as a transcript item", () => {
  // The source log: the typed command (not echoed), the handoff lifecycle (suppressed), and the result.
  const log = [
    ev(1, events.userCommand({ command: "/handoff", args: "--direct ship the feature" })),
    ev(
      2,
      events.handoffRequested({
        handoffId: "h1",
        mode: "direct",
        sourceSessionId: "src",
        prompt: "ship the feature",
      }),
    ),
    ev(
      3,
      events.handoffAccepted({
        handoffId: "h1",
        targetSessionId: "tgt",
        prompt: "ship the feature",
      }),
    ),
    ev(4, events.commandResult({ command: "/handoff", text: "✓ handed off to tgt", ok: true })),
  ];
  const transcript = toTranscript(log);
  // Only the command result renders - the lifecycle events and the typed command produce no rows, and
  // the prompt never appears as a source transcript item (it lives only in the target).
  assert.deepEqual(
    transcript.map((m) => m.kind),
    ["result"],
  );
  const result = transcript[0];
  assert.ok(result && result.kind === "result" && result.command === "/handoff" && result.ok);
  assert.ok(!transcript.some((m) => m.kind === "user"));
});

test("a terminal protocol-anomaly diagnostic folds onto the assistant segment", () => {
  // The host attaches a typed incident (reason protocol_anomaly) to the completion when the model
  // leaked raw tool-call markup as text. The fold carries it onto the segment so the row can render
  // the leak escaped; the leaked markup itself stays in `text`.
  const leak = '<｜tool▁calls｜>[{"name":"bash"}]<｜/tool▁calls｜>';
  const log = [
    ev(
      1,
      events.assistantStarted({ runId: "r1", model: "deepseek", provider: "deepseek", warm: true }),
    ),
    ev(2, events.assistantDelta({ runId: "r1", text: leak })),
    ev(
      3,
      events.assistantCompleted({
        runId: "r1",
        text: leak,
        stop: {
          cause: "provider_protocol_anomaly",
          action: "paused",
          summary: "Provider protocol anomaly during model-step",
        },
        diagnostic: {
          provider: "deepseek",
          model: "deepseek-v4",
          phase: "tool-protocol",
          reason: "protocol_anomaly",
          retryable: true,
          safeToRetry: false,
          attempt: 1,
          detail: "DeepSeek rendered tool-call JSON or tags as assistant text",
          partials: { textChars: leak.length, thinkingChars: 0, toolCalls: 0, toolResults: 0 },
        },
      }),
    ),
  ];
  const [message] = toTranscript(log).filter((m) => m.kind === "assistant");
  assert.ok(message && message.kind === "assistant");
  assert.equal(message.diagnostic?.reason, "protocol_anomaly");
  assert.equal(message.diagnostic?.phase, "tool-protocol");
  assert.equal(message.text, leak);
});

test("10-large-paste: a user.message's pasted payloads flow into the transcript user message", () => {
  const pastes = [{ text: "alpha\nbeta\ngamma" }];
  const log = [
    ev(
      1,
      events.userMessage({
        text: "log [Pasted text #1 +3 lines]",
        provider: "qwen",
        pastes,
      }),
    ),
  ];
  const user = toTranscript(log).find((m) => m.kind === "user");
  assert.ok(user && user.kind === "user");
  assert.deepEqual(
    user.pastes,
    pastes,
    "the exact payloads ride into the transcript for inspection",
  );

  const legacyUser = toTranscript([
    ev(1, events.userMessage({ text: "plain", provider: "qwen" })),
  ]).find((m) => m.kind === "user");
  assert.deepEqual(
    legacyUser?.kind === "user" ? legacyUser.pastes : null,
    [],
    "a legacy prompt with no pastes still decodes",
  );
});

test("plan 07: a tool.guardrail event reduces to a redacted inline guardrail marker", () => {
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(
      2,
      events.toolStarted({ runId: "r1", callId: "c0", name: "read", arguments: '{"path":"a"}' }),
    ),
    ev(3, events.toolCompleted({ runId: "r1", callId: "c0", name: "read", result: "same output" })),
    ev(
      4,
      events.toolGuardrail({
        runId: "r1",
        callId: "c0",
        name: "read",
        action: "warn",
        reason: "no_progress",
        count: 3,
        argsFingerprint: "0a1b2c3d4e5f",
        resultFingerprint: "deadbeef0011",
      }),
    ),
    ev(5, events.assistantCompleted({ runId: "r1", text: "done" })),
  ];
  const marker = toTranscript(log).find((m) => m.kind === "guardrail");
  assert.ok(marker, "a guardrail marker is produced");
  assert.deepEqual(marker, {
    kind: "guardrail",
    id: marker?.id,
    tool: "read",
    action: "warn",
    reason: "no_progress",
    count: 3,
  });
  // The marker carries none of the redacted fingerprints or any raw value.
  const dump = JSON.stringify(marker);
  assert.doesNotMatch(
    dump,
    /0a1b2c3d4e5f|deadbeef0011/,
    "fingerprints are not surfaced in the marker",
  );
  assert.doesNotMatch(dump, /same output|"path"/, "no raw output or arguments surface");
});

test("plan 25 M9: hook.decision deny/halt/context events reduce to attributed inline rows", () => {
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(
      2,
      events.hookDecision({
        runId: "r1",
        hookId: "project:guard",
        event: "PreToolUse",
        decision: "deny",
        toolName: "bash",
        reason: "workspace is read-only",
      }),
    ),
    ev(
      3,
      events.hookDecision({
        runId: "r1",
        hookId: "project:note",
        event: "PreToolUse",
        decision: "context",
        toolName: "read",
        reason: "heads up",
      }),
    ),
    ev(
      4,
      events.hookDecision({
        runId: "r1",
        hookId: "user:review",
        event: "Stop",
        decision: "halt",
        reason: "cover the edge case",
      }),
    ),
    ev(5, events.assistantCompleted({ runId: "r1", text: "done" })),
  ];
  const rows = toTranscript(log).filter((m) => m.kind === "hookDecision");
  assert.deepEqual(rows, [
    {
      kind: "hookDecision",
      id: rows[0]?.id,
      hookId: "project:guard",
      event: "PreToolUse",
      decision: "deny",
      toolName: "bash",
      reason: "workspace is read-only",
    },
    {
      kind: "hookDecision",
      id: rows[1]?.id,
      hookId: "project:note",
      event: "PreToolUse",
      decision: "context",
      toolName: "read",
      reason: "heads up",
    },
    {
      kind: "hookDecision",
      id: rows[2]?.id,
      hookId: "user:review",
      event: "Stop",
      decision: "halt",
      reason: "cover the edge case",
    },
  ]);
});

test("plan 25 M9: diagnostic hook.decision verbs produce no transcript row", () => {
  // updated_input/continuation/timeout/error/unapproved/trust_changed stay off the transcript:
  // the visible surfaces for those are the tool result, the continued text, and /doctor.
  const diagnostic = (seq: number, decision: string) =>
    ev(
      seq,
      events.raw("hook.decision", {
        runId: "r1",
        hookId: "project:x",
        event: "PreToolUse",
        decision,
      }),
    );
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    diagnostic(2, "updated_input"),
    diagnostic(3, "continuation"),
    diagnostic(4, "timeout"),
    diagnostic(5, "error"),
    diagnostic(6, "unapproved"),
    diagnostic(7, "trust_changed"),
    ev(8, events.assistantCompleted({ runId: "r1", text: "done" })),
  ];
  assert.equal(
    toTranscript(log).some((m) => m.kind === "hookDecision"),
    false,
    "only deny/halt/context render inline",
  );
});

test("plan 07: an ask_user guardrail marker is suppressed (no transcript row for ask_user)", () => {
  const log = [
    ev(1, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    ev(
      2,
      events.toolGuardrail({
        runId: "r1",
        callId: "c0",
        name: "ask_user",
        action: "warn",
        reason: "repeated_failure",
        count: 3,
        argsFingerprint: "0a1b2c3d4e5f",
      }),
    ),
    ev(3, events.assistantCompleted({ runId: "r1", text: "done" })),
  ];
  assert.equal(
    toTranscript(log).some((m) => m.kind === "guardrail"),
    false,
    "ask_user has no transcript row, so its guardrail marker is suppressed",
  );
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("plan 27: a lucid.published event yields one openable Lucid card, coalesced per version", () => {
  const log = [
    ev(0, events.userMessage({ text: "make a plan", provider: "openai" })),
    ev(
      1,
      events.lucidPublished({
        lucidId: "roadmap",
        version: 1,
        htmlHash: HASH_A,
        provenance: "agent",
        title: "Roadmap",
      }),
    ),
    // A second version of the SAME artifact updates the card in place (not a new card).
    ev(
      2,
      events.lucidPublished({
        lucidId: "roadmap",
        version: 2,
        htmlHash: HASH_B,
        provenance: "agent",
        title: "Roadmap v2",
      }),
    ),
  ];
  const cards = toTranscript(log).filter((m) => m.kind === "lucid");
  assert.equal(cards.length, 1, "versions of one artifact coalesce to one card");
  const card = cards[0];
  assert.equal(card?.kind === "lucid" && card.version, 2);
  assert.equal(card?.kind === "lucid" && card.title, "Roadmap v2");
  // The card carries a panel-openable ref that routes to the addressable viewer.
  if (card?.kind !== "lucid") {
    throw new Error("unreachable");
  }
  assert.equal(card.artifact.hash, HASH_B, "the ref points at the latest version's HTML blob");
  assert.equal(card.artifact.lucid?.lucidId, "roadmap");
  assert.equal(card.artifact.mimeType, "text/html");
});

test("plan 27: two distinct lucid artifacts render as two cards", () => {
  const log = [
    ev(
      0,
      events.lucidPublished({ lucidId: "a", version: 1, htmlHash: HASH_A, provenance: "agent" }),
    ),
    ev(
      1,
      events.lucidPublished({ lucidId: "b", version: 1, htmlHash: HASH_B, provenance: "agent" }),
    ),
  ];
  assert.equal(toTranscript(log).filter((m) => m.kind === "lucid").length, 2);
});

/** A web-authored user prompt with a stable eventId (a durable follow-up the queue references). */
const webUser = (seq: number, eventId: string, text: string): SessionEvent =>
  storedEvent(
    { type: "user.message", payload: { text, provider: "qwen" } },
    { seq, eventId, producerId: "trevor-web", createdAt: "2026-06-24T00:00:00.000Z" },
  );

const HOST_SELF = { selfProducerId: "trevor-host" };
const userTexts = (list: readonly Message[]): string[] =>
  list.filter((m) => m.kind === "user").map((m) => (m.kind === "user" ? m.text : ""));

test("plan 47: a follow-up queued behind an in-flight turn is hidden (rendered by the queue panel)", () => {
  const log = [
    webUser(1, "e1", "active prompt"),
    ev(2, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    webUser(3, "e2", "queued follow-up"),
  ];
  // The active prompt renders; the queued follow-up behind the running turn does not (no double-render).
  assert.deepEqual(userTexts(toTranscript(log, HOST_SELF)), ["active prompt"]);
});

test("plan 47: a superseded (folded/unqueued) prompt is hidden from the transcript", () => {
  const log = [
    webUser(1, "e1", "active prompt"),
    ev(2, events.assistantStarted({ runId: "r1", model: "qwen", provider: "qwen", warm: true })),
    webUser(3, "e2", "unqueued follow-up"),
    ev(4, events.userSupersede({ supersedes: ["e2"], reason: "unqueue" })),
  ];
  assert.deepEqual(userTexts(toTranscript(log, HOST_SELF)), ["active prompt"]);
});

test("plan 47: with no turn in flight, the awaiting prompt renders normally (no suppression)", () => {
  const log = [webUser(1, "e1", "awaiting prompt")];
  assert.deepEqual(userTexts(toTranscript(log, HOST_SELF)), ["awaiting prompt"]);
});
