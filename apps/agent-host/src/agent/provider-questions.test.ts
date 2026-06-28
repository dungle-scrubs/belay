import assert from "node:assert/strict";
import type {
  ProviderQuestionAnswer,
  ProviderQuestionContract,
  TrevorEventInput,
} from "@trevor/session";
import { Effect, Exit, Fiber } from "effect";
import { test } from "vitest";
import { formatToolResult, ProviderQuestionRuntime } from "./provider-questions";

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
