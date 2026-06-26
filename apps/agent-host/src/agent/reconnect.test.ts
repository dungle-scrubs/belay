import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Stream, TestClock } from "effect";
import type { ChatMessage, Provider, ProviderError, ProviderEvent } from "../providers";
import { ProviderAuthError, ProviderUnavailable } from "../providers/errors";
import { type AgentEvent, runAgent } from "./loop";

/**
 * Provider-outage auto-reconnect (D-076…D-079). A transient stream drop BEFORE any token is
 * retried with bounded backoff (3 attempts, ~300ms·900ms), emitting a `reconnecting` marker between
 * attempts; a drop AFTER output, a non-retryable error, or an exhausted budget is terminal; an
 * interrupt during a backoff cancels cleanly. Driven with TestClock so the backoff waits are
 * virtual (no real sleeps); a flaky fake provider fails N times then succeeds.
 */

const ANSWER: ProviderEvent[] = [
  { type: "text", text: "DONE" },
  { type: "usage", usage: { input: 5, output: 1, contextWindow: 1_000_000, genMs: 1 } },
];

/** A provider whose stream fails on its first `failBefore` calls (with `error`), then answers.
 *  `emitBeforeFail` streams one token before failing, to exercise the "drop after output" guard. */
function flakyProvider(opts: {
  failBefore: number;
  error: () => ProviderError;
  emitBeforeFail?: boolean;
  onCall?: () => void;
}): Provider {
  let calls = 0;
  const describe = {
    label: "Fake",
    model: "fake-1",
    reasoningLevels: ["off", "low"] as const,
    defaultReasoning: "off",
    kind: "cloud" as const,
  };
  return {
    id: "fake",
    ...describe,
    describe: () => describe,
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: false, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (): Stream.Stream<ProviderEvent, ProviderError> => {
      calls += 1;
      opts.onCall?.();
      if (calls <= opts.failBefore) {
        const fail = Stream.fail(opts.error());
        return opts.emitBeforeFail
          ? Stream.concat(Stream.succeed<ProviderEvent>({ type: "text", text: "partial" }), fail)
          : fail;
      }
      return Stream.fromIterable(ANSWER);
    },
  };
}

const retryable = () =>
  new ProviderUnavailable({ provider: "fake", detail: "websocket 1006 closed", retryable: true });
const nonRetryable = () =>
  new ProviderUnavailable({ provider: "fake", detail: "model not found", retryable: false });
const authError = () => new ProviderAuthError({ provider: "fake", detail: "401 unauthorized" });

const HISTORY: ChatMessage[] = [{ role: "user", content: "go" }];

/** Forks the loop, collecting events into a closure and returning the terminal Exit; advances the
 *  TestClock generously so the cascading backoff sleeps all fire. */
function drive(provider: Provider) {
  return Effect.gen(function* () {
    const events: AgentEvent[] = [];
    const fiber = yield* Stream.runForEach(runAgent(provider, HISTORY, "off", "r1"), (e) =>
      Effect.sync(() => void events.push(e)),
    ).pipe(Effect.exit, Effect.fork);
    // Let the fiber reach its first backoff, then advance past every (cascading) backoff.
    yield* TestClock.adjust(Duration.seconds(10));
    const exit = yield* Fiber.join(fiber);
    return { events, exit };
  });
}

const reconnects = (events: readonly AgentEvent[]) =>
  events.filter(
    (e): e is Extract<AgentEvent, { type: "reconnecting" }> => e.type === "reconnecting",
  );
const answerText = (events: readonly AgentEvent[]) =>
  events
    .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");

it.effect("a transient drop before the first token recovers transparently", () =>
  Effect.gen(function* () {
    const { events, exit } = yield* drive(flakyProvider({ failBefore: 2, error: retryable }));
    assert.ok(Exit.isSuccess(exit), "the turn completed after reconnecting");
    assert.deepEqual(
      reconnects(events).map((e) => e.attempt),
      [2, 3],
      "two reconnect markers, numbered with the upcoming attempt",
    );
    assert.equal(answerText(events), "DONE", "the answer streamed once reconnected");
  }),
);

it.effect("a drop AFTER output has streamed is terminal (never retried)", () =>
  Effect.gen(function* () {
    const { events, exit } = yield* drive(
      flakyProvider({ failBefore: 1, error: retryable, emitBeforeFail: true }),
    );
    assert.ok(Exit.isFailure(exit), "a mid-stream drop is terminal");
    assert.equal(reconnects(events).length, 0, "no reconnect once a token has streamed");
    assert.equal(
      answerText(events),
      "partial",
      "the partial output is what streamed before the drop",
    );
  }),
);

it.effect("a non-retryable outage is terminal, not retried", () =>
  Effect.gen(function* () {
    const { events, exit } = yield* drive(flakyProvider({ failBefore: 1, error: nonRetryable }));
    assert.ok(Exit.isFailure(exit));
    assert.equal(reconnects(events).length, 0, "retryable:false is never reconnected");
  }),
);

it.effect("an auth failure is terminal and unchanged (never retried)", () =>
  Effect.gen(function* () {
    const { events, exit } = yield* drive(flakyProvider({ failBefore: 1, error: authError }));
    assert.ok(Exit.isFailure(exit));
    assert.equal(reconnects(events).length, 0, "auth keeps its own dedicated handling");
  }),
);

it.effect("the reconnect budget is bounded: all-failing goes terminal after the last attempt", () =>
  Effect.gen(function* () {
    // Always fails: attempt 1 -> reconnect(2), attempt 2 -> reconnect(3), attempt 3 -> terminal.
    const { events, exit } = yield* drive(flakyProvider({ failBefore: 99, error: retryable }));
    assert.ok(Exit.isFailure(exit), "the budget is spent and the turn goes terminal");
    assert.deepEqual(
      reconnects(events).map((e) => e.attempt),
      [2, 3],
      "exactly two retries (three total attempts), then terminal",
    );
  }),
);

it.effect("an interrupt during a backoff cancels cleanly (no retry, no completion)", () =>
  Effect.gen(function* () {
    let callCount = 0;
    const provider = flakyProvider({
      failBefore: 99,
      error: retryable,
      onCall: () => {
        callCount += 1;
      },
    });
    const events: AgentEvent[] = [];
    const fiber = yield* Stream.runForEach(runAgent(provider, HISTORY, "off", "r1"), (e) =>
      Effect.sync(() => void events.push(e)),
    ).pipe(Effect.exit, Effect.fork);
    // Let it fail once and enter the first backoff sleep, but do NOT advance past it.
    yield* TestClock.adjust(Duration.millis(1));
    const callsBefore = callCount;
    yield* Fiber.interrupt(fiber);
    // The sleeping reconnect was interrupted: no further provider call happened.
    assert.equal(callCount, callsBefore, "the interrupted backoff never re-attempted the stream");
    assert.equal(reconnects(events).length, 1, "only the first reconnect marker was emitted");
  }),
);
