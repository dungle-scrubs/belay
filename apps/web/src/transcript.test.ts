import assert from "node:assert/strict";
import { test } from "node:test";
import {
  events,
  type SessionEvent,
  type TrevorEventInput,
  type UsageBreakdown,
} from "@trevor/session";
import { panelModel, toTranscript } from "./transcript";

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
