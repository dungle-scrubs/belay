import assert from "node:assert/strict";
import {
  events,
  type ProviderQuestionAnswer,
  type ProviderQuestionContract,
  type SessionEvent,
  type TrevorEventInput,
} from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { Effect, Exit, Fiber } from "effect";
import { test } from "vitest";
import {
  formatToolResult,
  orphanedQuestionReaps,
  ProviderQuestionRuntime,
} from "./provider-questions";

/**
 * The generic pending-question runtime: emit a request, block the tool call, resolve on a matching
 * answer (or cancel on interrupt). Driven through real Effect fibers - fork the blocking `ask`, let it
 * register + emit, then resolve/interrupt it - so the block/resume contract the host depends on is real.
 */

const SINGLE: ProviderQuestionContract = {
  schemaVersion: 1,
  questions: [
    {
      id: "db",
      question: "Which database?",
      answerShape: "single_choice",
      multiSelect: false,
      requiresReason: false,
      allowDefer: false,
      choices: [
        { id: "pg", label: "Postgres", recommended: true },
        { id: "sqlite", label: "SQLite" },
      ],
    },
  ],
};

const ACCEPT: ProviderQuestionAnswer = {
  action: "accept",
  answer: "Postgres",
  questions: [{ id: "db", answer: "Postgres", selected: [{ id: "pg", label: "Postgres" }] }],
};

function harness() {
  const rt = new ProviderQuestionRuntime();
  const emitted: TrevorEventInput[] = [];
  rt.configure((e) => emitted.push(e));
  return { rt, emitted };
}

const requestedId = (emitted: readonly TrevorEventInput[]): string => {
  const requested = emitted.find((e) => e.type === "provider.question.requested");
  assert.ok(requested, "a request event was emitted");
  return requested.payload.questionId as string;
};

test("ask emits a request, blocks, and an accept resolves it with a formatted result", async () => {
  const { rt, emitted } = harness();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(rt.ask(SINGLE, "r1", "tc1"));
      yield* Effect.yieldNow();
      assert.equal(rt.pendingCount, 1, "the call is blocked, waiting for an answer");
      assert.equal(rt.submitAnswer(requestedId(emitted), ACCEPT).status, "resolved");
      return yield* Fiber.join(fiber);
    }),
  );
  assert.match(result, /Postgres/);
  assert.equal(rt.pendingCount, 0);
  const resolved = emitted.find((e) => e.type === "provider.question.resolved");
  assert.equal(resolved?.payload.outcome, "answered");
  // The resolved summary is sanitized - it never carries the raw answer body.
  assert.equal(resolved?.payload.summary, "Answered 1 question");
});

test("a decline resolves the call with a decline result", async () => {
  const { rt, emitted } = harness();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(rt.ask(SINGLE, "r1", "tc1"));
      yield* Effect.yieldNow();
      assert.equal(rt.submitAnswer(requestedId(emitted), { action: "decline" }).status, "resolved");
      return yield* Fiber.join(fiber);
    }),
  );
  assert.match(result, /declined/i);
});

test("an answer for an unknown question id is rejected and disturbs no run (AQ001)", async () => {
  const { rt } = harness();
  assert.deepEqual(rt.submitAnswer("nope", ACCEPT), { status: "unknown" });
});

test("an answer that fails contract validation is rejected and leaves the call pending (AQ002)", async () => {
  const { rt, emitted } = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(rt.ask(SINGLE, "r1", "tc1"));
      yield* Effect.yieldNow();
      const bad: ProviderQuestionAnswer = {
        action: "accept",
        answer: "??",
        questions: [{ id: "db", answer: "??", selected: [{ id: "ghost", label: "Ghost" }] }],
      };
      const res = rt.submitAnswer(requestedId(emitted), bad);
      assert.equal(res.status, "invalid");
      assert.equal(rt.pendingCount, 1, "an invalid answer leaves the question pending");
      yield* Fiber.interrupt(fiber); // clean up the blocked fiber
    }),
  );
});

test("a duplicate answer after resolution reads as unknown (the question is closed)", async () => {
  const { rt, emitted } = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(rt.ask(SINGLE, "r1", "tc1"));
      yield* Effect.yieldNow();
      const qid = requestedId(emitted);
      assert.equal(rt.submitAnswer(qid, ACCEPT).status, "resolved");
      yield* Fiber.join(fiber);
      assert.deepEqual(rt.submitAnswer(qid, ACCEPT), { status: "unknown" });
    }),
  );
});

test("interrupting the blocked call (the run ended before an answer) cancels the question (AQ003)", async () => {
  const { rt, emitted } = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(rt.ask(SINGLE, "r1", "tc1"));
      yield* Effect.yieldNow();
      assert.equal(rt.pendingCount, 1);
      yield* Fiber.interrupt(fiber);
    }),
  );
  assert.equal(rt.pendingCount, 0);
  const resolved = emitted.find((e) => e.type === "provider.question.resolved");
  assert.equal(resolved?.payload.outcome, "cancelled");
});

test("ask fails fast on a structurally invalid contract (no questions)", async () => {
  const { rt } = harness();
  const exit = await Effect.runPromiseExit(rt.ask({ schemaVersion: 1, questions: [] }, "r", "tc"));
  assert.ok(Exit.isFailure(exit), "an empty group is rejected before blocking");
});

test("formatToolResult renders defer, notes, and reason per question", () => {
  const answer: ProviderQuestionAnswer = {
    action: "accept",
    answer: "x",
    questions: [
      { id: "a", answer: "Postgres", notes: "managed", reason: "reuse failover" },
      { id: "b", answer: "Deferred", defer: true },
    ],
  };
  const text = formatToolResult(answer);
  assert.match(text, /a: Postgres \(note: managed; reason: reuse failover\)/);
  assert.match(text, /b: \(deferred/);
});

// --- the orphaned-question reap (host restarted mid-question, the in-memory waiter died) ---

const questionRequested = (questionId: string, runId = "r1"): SessionEvent =>
  storedEvent(
    events.providerQuestionRequested({
      questionId,
      runId,
      toolCallId: `tc-${questionId}`,
      toolName: "ask_user",
      adapter: "ask_user",
      contract: SINGLE,
    }),
  );

const questionResolved = (questionId: string, runId = "r1"): SessionEvent =>
  storedEvent(
    events.providerQuestionResolved({
      questionId,
      runId,
      toolCallId: `tc-${questionId}`,
      outcome: "answered",
      summary: "Answered 1 question",
    }),
  );

test("reap cancels a requested question with no resolution (the waiter died with its host)", () => {
  const reaps = orphanedQuestionReaps([questionRequested("q1")], new Set());
  assert.equal(reaps.length, 1);
  assert.equal(reaps[0]?.type, "provider.question.resolved");
  assert.equal(reaps[0]?.payload.questionId, "q1");
  assert.equal(reaps[0]?.payload.runId, "r1", "carries the original run for the transcript row");
  assert.equal(reaps[0]?.payload.toolCallId, "tc-q1");
  assert.equal(reaps[0]?.payload.outcome, "cancelled", "recovered, never a fake answer");
});

test("reap skips a question that was already resolved", () => {
  const log = [questionRequested("q1"), questionResolved("q1")];
  assert.deepEqual(orphanedQuestionReaps(log, new Set()), []);
});

test("reap skips a question THIS host is actively blocking on (live-waiter exclusion)", () => {
  // The question analogue of reapExcept excluding the live run: a live waiter is not an orphan, so
  // a reconnect-as-existing-leader never cancels a real question out from under its blocked tool call.
  assert.deepEqual(orphanedQuestionReaps([questionRequested("q-live")], new Set(["q-live"])), []);
});

test("reap closes every orphan when several questions dangle (queued asks from a dead host)", () => {
  const log = [
    questionRequested("q1", "r1"),
    questionRequested("q2", "r2"),
    questionRequested("q3", "r3"),
    questionResolved("q2", "r2"),
  ];
  const reaps = orphanedQuestionReaps(log, new Set());
  assert.deepEqual(
    reaps.map((e) => e.payload.questionId),
    ["q1", "q3"],
    "only the unresolved questions are reaped",
  );
});

test("reap is idempotent: a second takeover after the cancelled resolution is in the log emits nothing", () => {
  const first = orphanedQuestionReaps([questionRequested("q1")], new Set());
  const afterFirstReap = [questionRequested("q1"), ...first.map((e) => storedEvent(e))];
  assert.deepEqual(orphanedQuestionReaps(afterFirstReap, new Set()), []);
});

test("reap ignores a dangling answer event without a resolution (the AQ001 no-op submits)", () => {
  // The wedged-session shape this fix exists for: the browser published provider.question.answer
  // events that no host could resolve. Those answers do NOT close the question - only a resolution
  // does - so the reap still cancels it.
  const log: SessionEvent[] = [
    questionRequested("q1"),
    storedEvent({
      type: "provider.question.answer",
      payload: { questionId: "q1", answer: { action: "accept", answer: "x", questions: [] } },
    }),
  ];
  const reaps = orphanedQuestionReaps(log, new Set());
  assert.equal(reaps.length, 1);
  assert.equal(reaps[0]?.payload.questionId, "q1");
});

test("pendingIds exposes exactly the live waiters (the reap's exclusion set)", async () => {
  const { rt, emitted } = harness();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(rt.ask(SINGLE, "r1", "tc1"));
      yield* Effect.yieldNow();
      const qid = requestedId(emitted);
      assert.deepEqual([...rt.pendingIds()], [qid]);
      // A pending live question is invisible to the reap even though its log pair is open.
      assert.deepEqual(orphanedQuestionReaps([questionRequested(qid)], rt.pendingIds()), []);
      yield* Fiber.interrupt(fiber);
    }),
  );
  assert.deepEqual([...rt.pendingIds()], []);
});
