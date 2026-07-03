import assert from "node:assert/strict";
import {
  fakeProvider,
  providerQuestionRuntime,
  publishTurnVia,
  transportEmit,
} from "@trevor/agent-host/testing";
import type { RunningServer } from "@trevor/server-kit";
import {
  type ProviderQuestionAnswer,
  events as sessionEvents,
  streamTransport,
} from "@trevor/session";
import { questionAnswerDrain, subscribe, waitFor } from "@trevor/test-kit";
import { bootStore } from "@trevor/test-kit/boot";
import { Stream } from "effect";
import { afterAll, afterEach, beforeAll, test } from "vitest";

/**
 * S-E2E ask_user (hermetic): the full block -> answer -> resume loop over a REAL session-store, minus
 * the model. The fake provider calls ask_user; the host turn pipeline blocks the tool call and emits
 * `provider.question.requested`; a subscriber (standing in for the browser) publishes
 * `provider.question.answer`; the host-side consumer (the role main.ts's inbound lane plays) resolves
 * the question, the tool unblocks with the user's choice, and the turn completes. Proves the answer
 * resumes the active tool call - it never becomes a new prompt - and the question never leaks into the
 * model conversation as anything but the tool result.
 */

let store: RunningServer;

beforeAll(async () => {
  store = await bootStore();
});

afterAll(async () => {
  await store.close();
});

afterEach(() => {
  providerQuestionRuntime.reset();
});

test("a fake-provider ask_user turn blocks, then resumes with the browser's answer", async () => {
  const transport = streamTransport(store.url);
  const SESSION = "ask-user";
  await transport.ensureSession(SESSION);

  // Wire the runtime to publish its request/resolved events to the store (the host's emit role).
  providerQuestionRuntime.configure((event) => {
    void transport.publishEvent(SESSION, { producerId: "host", ...event });
  });

  const viewer = subscribe(transport, SESSION, "viewer");
  await waitFor(viewer.isReplayed);

  // The host-side consumer: on a browser answer, resolve the pending question (main.ts's inbound lane).
  const host = subscribe(transport, SESSION, "host-consumer");
  const drainAnswers = questionAnswerDrain(host.events, (questionId, answer) =>
    providerQuestionRuntime.submitAnswer(questionId, answer),
  );

  // The fake provider: step 1 calls ask_user; after the tool result, step 2 answers.
  let calls = 0;
  const usage = { input: 10, output: 1, contextWindow: 200_000, genMs: 1 } as const;
  const turn = publishTurnVia(
    transportEmit(transport, SESSION, "host"),
    fakeProvider({
      stream: (_messages, _tools) => {
        calls += 1;
        if (calls === 1) {
          return Stream.fromIterable([
            {
              type: "tool_call" as const,
              call: {
                id: "call-1",
                name: "ask_user",
                arguments: JSON.stringify({
                  question: "Which database should the service use?",
                  choices: [
                    { id: "pg", label: "Postgres" },
                    { id: "sqlite", label: "SQLite" },
                  ],
                }),
              },
            },
            { type: "usage" as const, usage },
          ]);
        }
        return Stream.fromIterable([
          { type: "text" as const, text: "Recorded the database choice." },
          { type: "usage" as const, usage },
        ]);
      },
    }),
    [{ role: "user", content: "Set up the database." }],
    { runId: "r-ask" },
  );

  // 1) The tool blocks and the request reaches the store.
  await waitFor(() => viewer.events.some((e) => e.type === "provider.question.requested"), {
    label: "provider.question.requested",
  });
  const requested = viewer.events.find((e) => e.type === "provider.question.requested");
  const questionId = String(requested?.payload.questionId ?? "");
  assert.ok(questionId, "the request carries a question id");

  // 2) The browser publishes the answer (Postgres), then the host consumer resolves it.
  const answer: ProviderQuestionAnswer = {
    action: "accept",
    answer: "Postgres",
    questions: [
      { id: "question_1", answer: "Postgres", selected: [{ id: "pg", label: "Postgres" }] },
    ],
  };
  await transport.publishEvent(SESSION, {
    producerId: "web",
    ...sessionEvents.providerQuestionAnswer({ questionId, answer }),
  });
  await waitFor(() => host.events.some((e) => e.type === "provider.question.answer"), {
    label: "provider.question.answer",
  });
  drainAnswers();

  // 3) The turn resumes and completes; the question resolves.
  await turn;
  await waitFor(() => viewer.events.some((e) => e.type === "assistant.completed"), {
    label: "assistant.completed",
  });

  const resolved = viewer.events.find((e) => e.type === "provider.question.resolved");
  assert.equal(resolved?.payload.outcome, "answered", "the question resolved as answered");

  // The answer resumed the BLOCKED tool call: it returns as the tool result, never a new user.message.
  const toolDone = viewer.events.find(
    (e) => e.type === "tool.completed" && e.payload.name === "ask_user",
  );
  assert.ok(
    String(toolDone?.payload.result ?? "").includes("Postgres"),
    "the user's choice is the ask_user tool result",
  );
  assert.equal(
    viewer.events.filter((e) => e.type === "user.message").length,
    0,
    "the answer resumed the tool call - it did not create a user.message prompt",
  );

  const completed = viewer.events.find((e) => e.type === "assistant.completed");
  assert.equal(completed?.payload.error, undefined);
  assert.ok(String(completed?.payload.text ?? "").includes("Recorded the database choice."));

  viewer.connection.close();
  host.connection.close();
});
