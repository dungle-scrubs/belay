import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import type {
  ConnectSessionOptions,
  PublishInput,
  SessionEvent,
  SessionTransport,
} from "@trevor/session";
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
  // The tail path batches per flush window now, so let the pending flush commit before asserting.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16);
  });
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1, 2],
  );

  unmount();
});

test("coalesces a live tail burst into one commit per flush window", async () => {
  vi.useFakeTimers();
  const { connects, transport } = recordingTransport();
  // Track state commits by events-array identity: every setEvents produces a fresh array, so the
  // number of distinct identities across renders counts commits without status renders muddying it.
  const commits: (readonly SessionEvent[])[] = [];
  const { result, unmount } = renderHook(() => {
    const stream = useSessionWithTransport(transport, "s");
    if (commits.at(-1) !== stream.events) {
      commits.push(stream.events);
    }
    return stream;
  });

  act(() => {
    connects[0]?.onEvent(event(1, "first"));
    connects[0]?.onReplayComplete?.();
  });
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1],
  );

  const commitsBeforeBurst = commits.length;
  act(() => {
    connects[0]?.onEvent(event(2, "a"));
    connects[0]?.onEvent(event(3, "b"));
    connects[0]?.onEvent(event(4, "c"));
  });
  // The burst is buffered: nothing commits until the flush window elapses.
  assert.equal(commits.length, commitsBeforeBurst);
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1],
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(16);
  });
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  // The whole burst landed as ONE state commit, not one per event.
  assert.equal(commits.length, commitsBeforeBurst + 1);

  unmount();
});

test("buffers a reconnect catch-up replay into one appended commit", async () => {
  vi.useFakeTimers();
  const rt = recordingTransport();
  const { connects, transport } = rt;
  const commits: (readonly SessionEvent[])[] = [];
  const { result, unmount } = renderHook(() => {
    const stream = useSessionWithTransport(transport, "s");
    if (commits.at(-1) !== stream.events) {
      commits.push(stream.events);
    }
    return stream;
  });

  act(() => {
    connects[0]?.onEvent(event(1, "first"));
    connects[0]?.onReplayComplete?.();
  });
  assert.equal(result.current.replayed, true);
  assert.equal(result.current.replayThroughSeq, 1);

  act(() => {
    connects[0]?.onStatus?.("closed");
  });

  // The events missed during the flap ride the reconnect's own replay-then-complete flow (the
  // recording transport replays the seeded log via microtask, then signals replay complete).
  rt.seed("s", [event(2, "a"), event(3, "b"), event(4, "c")]);
  const commitsBeforeReconnect = commits.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });

  assert.equal(connects.length, 2);
  assert.equal(connects[1]?.afterSeq, 1);
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  // The whole catch-up burst APPENDED as one commit, not one per missed event.
  assert.equal(commits.length, commitsBeforeReconnect + 1);
  // A reconnect replay never resets the initial page-load boundary consumers key side effects on.
  assert.equal(result.current.replayed, true);
  assert.equal(result.current.replayThroughSeq, 1);

  unmount();
});

test("a disconnect mid-replay keeps the buffered events across the reconnect", async () => {
  vi.useFakeTimers();
  // Manual connections (no auto replay-complete): a real WS that drops mid-replay never delivers
  // its replay.complete, but recordingTransport's connectSession always fires it via microtask,
  // which would mask the bug this guards against. The wrapper records connects and leaves every
  // callback to the test.
  const rt = recordingTransport();
  const connects: ConnectSessionOptions[] = [];
  const transport: SessionTransport = {
    ...rt.transport,
    connectSession: (options) => {
      connects.push(options);
      options.onStatus?.("open");
      return { close: () => {} };
    },
  };
  const { result, unmount } = renderHook(() => useSessionWithTransport(transport, "s"));

  // The initial replay delivers part of the history, then the socket drops BEFORE the replay
  // completes. lastSeq has already advanced past the buffered events, so the reconnect asks
  // afterSeq=2 and the server never resends seqs 1-2 - the buffer must outlive the connection.
  act(() => {
    connects[0]?.onEvent(event(1, "first"));
    connects[0]?.onEvent(event(2, "second"));
    connects[0]?.onStatus?.("closed");
  });
  assert.equal(result.current.replayed, false);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  assert.equal(connects.length, 2);
  assert.equal(connects[1]?.afterSeq, 2);

  // The retry resumes the same replay and completes it: the committed initial history is the
  // UNION of both attempts, not just the retry's tail.
  act(() => {
    connects[1]?.onEvent(event(3, "third"));
    connects[1]?.onReplayComplete?.();
  });
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(result.current.replayed, true);
  assert.equal(result.current.replayThroughSeq, 3);

  unmount();
});

test("flushes a pending tail buffer when the connection closes", async () => {
  vi.useFakeTimers();
  const { connects, transport } = recordingTransport();
  const { result, unmount } = renderHook(() => useSessionWithTransport(transport, "s"));

  act(() => {
    connects[0]?.onEvent(event(1, "first"));
    connects[0]?.onReplayComplete?.();
  });

  act(() => {
    connects[0]?.onEvent(event(2, "a"));
    connects[0]?.onEvent(event(3, "b"));
  });
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1],
  );

  // The close flushes the buffer synchronously (no timer advance), so nothing buffered is lost or
  // delayed across the reconnect gap.
  act(() => {
    connects[0]?.onStatus?.("closed");
  });
  assert.deepEqual(
    result.current.events.map((e) => e.seq),
    [1, 2, 3],
  );

  unmount();
});

test("createSessionActions maps user intents to Trevor events", async () => {
  const built: PublishInput[] = [];
  const actions = createSessionActions(async (event) => {
    built.push({ producerId: "web", ...event });
  });

  await actions.publish({
    text: "hello",
    provider: "qwen",
    reasoning: "high",
    artifacts: [{ kind: "image", hash: "h", mimeType: "image/png", size: 1 }],
    model: {
      sourceId: "qwen",
      modelId: "coder",
      reasoning: "high",
    },
  });
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
  await actions.reconcileSubagent({
    runId: "r1",
    childSessionId: "s::sub::bg",
    agent: "explorer",
    task: "scan the repo",
    mode: "background",
  });

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
      "delegated.to",
    ],
  );
  // The subagent recovery (plan 52): a terminal interrupted link keyed by childSessionId, NOT failed - the
  // child was reaped by orphan recovery, not a genuine task error. Carries the original link fields so the
  // reducer advances the existing block, plus a recovery summary in result.
  assert.equal(built[14]?.payload.childSessionId, "s::sub::bg");
  assert.equal(built[14]?.payload.status, "interrupted");
  assert.equal(built[14]?.payload.agent, "explorer");
  assert.match(String(built[14]?.payload.result), /browser recovered/);
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
