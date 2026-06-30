import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import type { PublishInput, SessionEvent } from "@trevor/session";
import { recordingTransport, storedEvent } from "@trevor/test-kit";
import { afterEach, test, vi } from "vitest";
import { createSessionActions, useSessionWithTransport } from "./use-session";

const event = (seq: number, type: string): SessionEvent =>
  storedEvent(
    { type, payload: {} },
    { sessionId: "s", seq, eventId: `e-${seq}`, producerId: "test" },
  );

afterEach(() => {
  vi.useRealTimers();
});

test("reconnects after a closed stream and catches up from the last seen seq", async () => {
  vi.useFakeTimers();
  const { connects, transport } = recordingTransport();

  const { result, unmount } = renderHook(() => useSessionWithTransport(transport, "s"));

  assert.equal(connects.length, 1);
  act(() => {
    connects[0]?.onEvent(event(1, "first"));
    connects[0]?.onReplayComplete?.();
  });
  assert.equal(result.current.replayed, true);
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1],
  );

  act(() => {
    connects[0]?.onStatus?.("closed");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });

  assert.equal(connects.length, 2);
  assert.equal(connects[1]?.afterSeq, 1);

  act(() => {
    connects[1]?.onEvent(event(2, "second"));
    connects[1]?.onReplayComplete?.();
  });
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1, 2],
  );

  unmount();
});

test("createSessionActions maps user intents to Trevor events", async () => {
  const built: PublishInput[] = [];
  const actions = createSessionActions(async (event) => {
    built.push({ producerId: "web", ...event });
  });

  await actions.publish(
    "hello",
    "qwen",
    "high",
    [{ kind: "image", hash: "h", mimeType: "image/png", size: 1 }],
    {
      sourceId: "qwen",
      modelId: "coder",
      reasoning: "high",
    },
  );
  await actions.cancel("r1");
  await actions.switchModel("r1", {
    sourceId: "deepseek",
    modelId: "deepseek-v4",
    reasoning: "high",
  });
  await actions.command("/doctor", "refresh");
  await actions.shell("shell-1", "pwd");
  await actions.openInEditor("/tmp/a.ts", 3, 4);
  await actions.refreshInternet();
  await actions.refreshCatalog();
  await actions.signInSource("openai");
  await actions.cancelSignIn();
  await actions.submitSignInCode("abc123");
  await actions.unarchive();
  await actions.answerQuestion("q-1", {
    action: "accept",
    answer: "Postgres",
    questions: [{ id: "db", answer: "Postgres", selected: [{ id: "pg", label: "Postgres" }] }],
  });
  await actions.reconcileTurn("r9");

  assert.deepEqual(
    built.map((event) => event.type),
    [
      "user.message",
      "user.cancel",
      "model.switch.requested",
      "user.command",
      "user.shell",
      "editor.open",
      "user.command",
      "user.command",
      "user.command",
      "user.command",
      "user.command",
      "session.archived",
      "provider.question.answer",
      "assistant.completed",
    ],
  );
  // The mid-turn switch control event (09.1): keyed to the active run, carrying the target ref + initiator.
  assert.deepEqual(built[2]?.payload, {
    runId: "r1",
    model: { sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "high" },
    initiator: "manual",
  });
  // The web stall guard's recovery: an interrupted (not user-cancelled) terminal event for the run.
  assert.equal(built[13]?.payload.runId, "r9");
  assert.equal(built[13]?.payload.interrupted, true);
  assert.equal((built[13]?.payload.stop as { cause: string } | undefined)?.cause, "interrupted");
  assert.deepEqual(built[12]?.payload, {
    questionId: "q-1",
    answer: {
      action: "accept",
      answer: "Postgres",
      questions: [{ id: "db", answer: "Postgres", selected: [{ id: "pg", label: "Postgres" }] }],
    },
  });
  assert.deepEqual(built[0]?.payload, {
    text: "hello",
    provider: "qwen",
    reasoning: "high",
    model: { sourceId: "qwen", modelId: "coder", reasoning: "high" },
    artifacts: [{ kind: "image", hash: "h", mimeType: "image/png", size: 1 }],
  });
  assert.deepEqual(built[6]?.payload, { command: "/internet-refresh", args: "" });
  assert.deepEqual(built[8]?.payload, { command: "/source-signin", args: "openai" });
  assert.deepEqual(built[11]?.payload, { archived: false });
});
