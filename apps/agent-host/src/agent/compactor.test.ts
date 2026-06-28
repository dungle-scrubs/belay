import assert from "node:assert/strict";
import {
  events,
  PRODUCER_IDS,
  type ProducerId,
  type SessionEvent,
  type TrevorEventInput,
} from "@trevor/session";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import type { Provider, ProviderEvent } from "../providers";
import { COMPACT_TO, COMPACT_WHEN, overBudget, planCompaction, runCompaction } from "./compactor";
import { buildHistory } from "./history-projection";

/**
 * Phase 3 (cross-turn compaction, D-040/D-041): the trigger + fold planner. `planCompaction` is
 * pure - these drive it with synthetic logs to pin the budget gate, which turns fold vs stay
 * verbatim, the rolling-chain prior-fold handling, and the post-fold size estimate. `runCompaction`
 * adds the one tool-less summary call with a fake provider.
 */

const SELF: ProducerId = PRODUCER_IDS.host;
const WEB: ProducerId = PRODUCER_IDS.web;

let seq = 0;
function ev(input: TrevorEventInput, producerId = WEB): SessionEvent {
  const n = seq++;
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    eventId: `e${n}`,
    payload: input.payload,
    producerId,
    seq: n,
    sessionId: "test",
    type: input.type,
  };
}

/** A completed turn: a user prompt + the assistant's reply (host-authored), as two log events. */
function turn(userText: string, assistantText: string): [SessionEvent, SessionEvent] {
  return [
    ev(events.userMessage({ text: userText, provider: "qwen" })),
    ev(events.assistantCompleted({ runId: "r", text: assistantText }), SELF),
  ];
}

test("overBudget gates on the window fraction, treating an unknown window as under budget", () => {
  assert.equal(overBudget(80, 100, COMPACT_WHEN), true, "80/100 = 80% hits the gate");
  assert.equal(overBudget(79, 100, COMPACT_WHEN), false, "just under");
  assert.equal(overBudget(9_999, 0, COMPACT_WHEN), false, "unknown window never trips");
  assert.equal(COMPACT_WHEN > COMPACT_TO, true, "compact-when is above compact-to (headroom)");
});

test("planCompaction folds the oldest turns and keeps the most recent under budget", () => {
  // Window 8k → target 4k tokens; each assistant reply ~4000 chars (~1000 tokens). The two newest
  // turns fit under the budget; the three oldest fold.
  const big = "y".repeat(4_000);
  const t1 = turn("one", big);
  const t2 = turn("two", big);
  const t3 = turn("three", big);
  const t4 = turn("four", big);
  const t5 = turn("five", big);
  const log = [...t1, ...t2, ...t3, ...t4, ...t5];

  const plan = planCompaction(log, 8_000, SELF, 7_200);
  assert.ok(plan, "a fold is planned");
  if (!plan) return;
  // throughSeq lands on the 3rd turn's assistant.completed - turns 4 and 5 stay verbatim.
  assert.equal(plan.throughSeq, t3[1].seq, "folds through the 3rd turn boundary");
  assert.equal(plan.foldedTurns.length, 6, "3 folded turns × (user + assistant)");
  assert.equal(plan.priorSummary, null, "first fold has no prior summary");
  assert.equal(plan.manifest.turnRange.fromSeq, t1[0].seq);
  assert.equal(plan.manifest.turnRange.toSeq, t3[1].seq);
  assert.ok(plan.tokensAfter < plan.tokensBefore, "the estimate drops below the pre-fold size");
});

test("planCompaction returns null when the window is unknown or there is too little to fold", () => {
  const log = [...turn("a", "x"), ...turn("b", "y")];
  assert.equal(planCompaction(log, 0, SELF, 9_999), null, "unknown window → no plan");
  // One completed turn (<= MIN_RECENT) → nothing to fold even over budget.
  assert.equal(planCompaction([...turn("solo", "x")], 100, SELF, 99), null, "too few turns");
});

test("planCompaction only folds turns newer than the prior fold and chains off it", () => {
  const big = "z".repeat(4_000);
  const t1 = turn("one", big);
  const t2 = turn("two", big);
  // A prior fold already covered through t1's assistant.completed.
  const prior = ev(
    events.contextCompacted({
      foldId: "fold-prior",
      throughSeq: t1[1].seq,
      summary: "the first turn, summarized",
      manifest: {
        turnRange: { fromSeq: t1[0].seq, toSeq: t1[1].seq },
        files: [],
        tools: [],
        topics: [],
      },
      tokensBefore: 9_000,
      tokensAfter: 4_000,
      model: "qwen",
    }),
    SELF,
  );
  const t3 = turn("three", big);
  const t4 = turn("four", big);
  const log = [...t1, prior, ...t2, ...t3, ...t4];

  const plan = planCompaction(log, 8_000, SELF, 7_500);
  assert.ok(plan, "a fold is planned over the new turns");
  if (!plan) return;
  assert.equal(plan.priorFoldId, "fold-prior", "chains off the prior fold");
  assert.equal(plan.priorSummary, "the first turn, summarized", "extends the prior summary");
  // t1 is already folded; only t2/t3/t4 are candidates, so the fold never reaches back past t1.
  assert.ok(plan.throughSeq > t1[1].seq, "throughSeq advances past the prior fold");
  assert.equal(
    plan.manifest.turnRange.fromSeq,
    t2[0].seq,
    "the new fold starts after the prior one",
  );
});

function fakeProvider(summaryText: string): Provider {
  return {
    id: "fake",
    label: "Fake",
    model: "fake-1",
    reasoningLevels: ["off", "low"],
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => ({
      label: "Fake",
      model: "fake-1",
      reasoningLevels: ["off", "low"],
      defaultReasoning: "off",
      kind: "cloud",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: () => Stream.fromIterable<ProviderEvent>([{ type: "text", text: summaryText }]),
  };
}

test("runCompaction emits a context.compacted carrying the summary, throughSeq, and token estimates", async () => {
  const big = "w".repeat(8_000);
  const t1 = turn("one", big);
  const t2 = turn("two", big);
  const t3 = turn("three", big);
  const log = [...t1, ...t2, ...t3];

  const event = await Effect.runPromise(
    runCompaction(fakeProvider("a tidy summary"), log, 8_000, SELF, 7_000, "fold-new"),
  );
  assert.ok(event, "an event is produced");
  if (!event) return;
  assert.equal(event.type, "context.compacted");
  assert.equal(event.payload.foldId, "fold-new");
  assert.equal(event.payload.summary, "a tidy summary");
  assert.equal(event.payload.model, "fake-1");
  assert.equal(typeof event.payload.throughSeq, "number");
  assert.ok((event.payload.tokensAfter as number) < (event.payload.tokensBefore as number));
});

test("force folds every completed turn even far under budget or with an unknown window", () => {
  // Two completed turns, ~1.5k tokens total, in a 1M window: auto would never fold (way under
  // budget). Manual /compact (force) folds them anyway - the user's choice.
  const log = [...turn("a", "x".repeat(3_000)), ...turn("b", "y".repeat(3_000))];
  assert.equal(
    planCompaction(log, 1_000_000, SELF, 6_000),
    null,
    "auto leaves a small convo alone",
  );

  const forced = planCompaction(log, 1_000_000, SELF, 6_000, true);
  assert.ok(forced, "force folds even far under budget");
  if (!forced) return;
  assert.equal(forced.throughSeq, log[3]?.seq, "folds through the last completed turn");

  assert.ok(planCompaction(log, 0, SELF, 0, true), "force ignores the unknown-window gate too");
});

test("a turn's tool results drive its fold size and are summarized (the carry, not just text)", () => {
  // A read-heavy turn: a small prompt + a huge tool result. The tool result is what fills the
  // window, so the turn must be sized by it (not just its few chars of text) and folded.
  const big = "f".repeat(20_000); // ~5000 tokens of file contents
  const u = ev(events.userMessage({ text: "read x", provider: "qwen" }));
  const ts = ev(
    events.toolStarted({ runId: "r", callId: "c1", name: "read", arguments: '{"path":"x"}' }),
    SELF,
  );
  const tc = ev(
    events.toolCompleted({ runId: "r", callId: "c1", name: "read", result: big }),
    SELF,
  );
  const a = ev(events.assistantCompleted({ runId: "r", text: "x is big" }), SELF);
  const log = [u, ts, tc, a, ...turn("anything else", "ok")];

  const plan = planCompaction(log, 8_000, SELF, 7_000);
  assert.ok(plan, "the read-heavy turn is foldable, sized by its tool result");
  if (!plan) return;
  assert.equal(plan.throughSeq, a.seq, "folds through the read turn");
  const foldedContent = plan.foldedTurns.map((m) => m.content).join("");
  assert.ok(foldedContent.includes(big), "the tool result is part of what gets summarized");
});

test("runCompaction yields null when there is nothing to fold", async () => {
  const event = await Effect.runPromise(
    runCompaction(fakeProvider("unused"), [...turn("solo", "x")], 100, SELF, 99, "fold-x"),
  );
  assert.equal(event, null);
});

test("integration: applying a fold shrinks the next turn's projection, pre-compacted", async () => {
  // The end-to-end claim (D-040/D-041): a conversation grown over the window is folded, and the
  // NEXT turn's prompt projection drops well below the pre-fold size. Drives the real planner +
  // summarizer + projection together (char count proxies for tokens).
  const big = "q".repeat(4_000);
  const log = [
    ...turn("t1", big),
    ...turn("t2", big),
    ...turn("t3", big),
    ...turn("t4", big),
    ...turn("t5", big),
  ];
  const projChars = (messages: { content: string }[]) =>
    messages.reduce((sum, m) => sum + m.content.length, 0);
  const before = projChars(buildHistory(log, { selfProducerId: SELF }));

  const fold = await Effect.runPromise(
    runCompaction(fakeProvider("a short rolling summary"), log, 8_000, SELF, 7_200, "fold-1"),
  );
  assert.ok(fold, "a fold is produced");
  if (!fold) return;

  // Apply the fold the way the host does: append the event to the durable log, then re-project.
  const after = buildHistory([...log, ev(fold, SELF)], { selfProducerId: SELF });
  assert.ok(projChars(after) < before / 2, "the next turn's projection is pre-compacted (< half)");
  assert.equal(after[0]?.content, "t1", "the original goal stays pinned");
  assert.match(
    after[1]?.content ?? "",
    /a short rolling summary/,
    "the rolling summary is injected",
  );
  assert.equal(after.at(-1)?.content, big, "the most recent turn stays verbatim");
});
