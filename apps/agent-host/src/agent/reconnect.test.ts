import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, Option, Stream, TestClock } from "effect";
import { afterEach, beforeEach, describe } from "vitest";
import type { ChatMessage, Provider, ProviderError, ProviderEvent } from "../providers";
import { ProviderAuthError, ProviderUnavailable } from "../providers";
import { readObservations, summarizeObservations } from "../providers/observation-store";
import { type AgentEvent, runAgent } from "./loop";

/**
 * Provider-outage auto-reconnect (D-076…D-079). A transient stream drop BEFORE any token is
 * retried with bounded backoff (10 attempts, a ramping curve capped at 15s for ~75s cumulative,
 * 02.15), emitting a `reconnecting` marker between attempts; a drop AFTER output, a non-retryable
 * error, or an exhausted budget is terminal; an interrupt during a backoff cancels cleanly. Driven
 * with TestClock so the backoff waits are virtual (no real sleeps); a flaky fake provider fails N
 * times then succeeds.
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
  thinkBeforeFail?: boolean;
  toolCallBeforeFail?: boolean;
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
        if (opts.thinkBeforeFail) {
          return Stream.concat(
            Stream.succeed<ProviderEvent>({ type: "thinking", text: "checking the repo" }),
            fail,
          );
        }
        if (opts.toolCallBeforeFail) {
          return Stream.concat(
            Stream.succeed<ProviderEvent>({
              type: "tool_call",
              call: { id: "c1", name: "bash", arguments: "{}" },
            }),
            fail,
          );
        }
        return opts.emitBeforeFail
          ? Stream.concat(Stream.succeed<ProviderEvent>({ type: "text", text: "partial" }), fail)
          : fail;
      }
      return Stream.fromIterable(ANSWER);
    },
  };
}

const retryable = () =>
  new ProviderUnavailable({
    provider: "fake",
    detail: "websocket 1006 closed",
    retryable: true,
    classification: "transient_transport",
  });
const nonRetryable = () =>
  new ProviderUnavailable({ provider: "fake", detail: "model not found", retryable: false });
const authError = () => new ProviderAuthError({ provider: "fake", detail: "401 unauthorized" });
/** A terminal failure whose SHAPE the classifier didn't recognize - the observation-store case. */
const unknownClassified = () =>
  new ProviderUnavailable({
    provider: "fake",
    detail: "weird never-before-seen provider failure 9f3a",
    retryable: false,
    classification: "unknown",
    evidence: { status: 418, code: "teapot", shapeFields: ["error", "status"] },
  });
const secretBearingRetryable = () =>
  new ProviderUnavailable({
    provider: "fake",
    detail: "stream failed with Authorization: Bearer sk-secret123456789",
    retryable: true,
    classification: "transient_transport",
  });

const HISTORY: ChatMessage[] = [{ role: "user", content: "go" }];

/** Forks the loop, collecting events into a closure and returning the terminal Exit; advances the
 *  TestClock generously so the cascading backoff sleeps all fire. */
function drive(provider: Provider) {
  return Effect.gen(function* () {
    const events: AgentEvent[] = [];
    const fiber = yield* Stream.runForEach(runAgent(provider, HISTORY, "off", "r1"), (e) =>
      Effect.sync(() => void events.push(e)),
    ).pipe(Effect.exit, Effect.fork);
    // Let the fiber reach its first backoff, then advance past every (cascading) backoff. The window
    // covers the full 10-attempt budget's ~75s cumulative backoff + jitter (02.15), so an all-failing
    // run reaches its terminal failure within the virtual clock.
    yield* TestClock.adjust(Duration.seconds(120));
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
    // Each marker carries the full attempt budget so the UI shows a true denominator (02.15).
    assert.equal(
      reconnects(events)[0]?.maxAttempts,
      10,
      "the marker carries the 10-attempt budget",
    );
    assert.equal(answerText(events), "DONE", "the answer streamed once reconnected");
  }),
);

it.effect("a DeepSeek-style thinking-only stream drop retries with a provider diagnostic", () =>
  Effect.gen(function* () {
    const { events, exit } = yield* drive(
      flakyProvider({ failBefore: 1, error: retryable, thinkBeforeFail: true }),
    );
    assert.ok(Exit.isSuccess(exit), "thinking-only partials are safe to retry");
    const [marker] = reconnects(events);
    assert.equal(marker?.attempt, 2);
    assert.deepEqual(marker?.diagnostic?.partials, {
      textChars: 0,
      thinkingChars: "checking the repo".length,
      toolCalls: 0,
      toolResults: 0,
    });
    assert.equal(marker?.diagnostic?.reason, "transport_loss");
    assert.equal(marker?.diagnostic?.retryable, true);
    assert.equal(marker?.diagnostic?.safeToRetry, true);
    assert.equal(answerText(events), "DONE");
  }),
);

it.effect("provider diagnostics redact secret-bearing detail fields", () =>
  Effect.gen(function* () {
    const { events, exit } = yield* drive(
      flakyProvider({ failBefore: 1, error: secretBearingRetryable, thinkBeforeFail: true }),
    );
    assert.ok(Exit.isSuccess(exit), "the retry still succeeds");
    const [marker] = reconnects(events);
    assert.ok(marker?.diagnostic?.detail.includes("«redacted»"));
    assert.ok(!marker?.diagnostic?.detail.includes("sk-secret123456789"));
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
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
    assert.equal(Option.isSome(failure), true);
    if (Option.isSome(failure)) {
      assert.equal(failure.value._tag, "ProviderUnavailable");
      assert.equal(failure.value.diagnostic?.safeToRetry, false);
      assert.equal(failure.value.diagnostic?.partials.textChars, "partial".length);
    }
  }),
);

it.effect("a drop after a typed tool call is terminal and records unsafe retry state", () =>
  Effect.gen(function* () {
    const { events, exit } = yield* drive(
      flakyProvider({ failBefore: 1, error: retryable, toolCallBeforeFail: true }),
    );
    assert.ok(Exit.isFailure(exit), "a tool-call boundary is terminal");
    assert.equal(reconnects(events).length, 0, "no reconnect once a tool call crossed");
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
    assert.equal(Option.isSome(failure), true);
    if (Option.isSome(failure)) {
      assert.equal(failure.value._tag, "ProviderUnavailable");
      assert.equal(failure.value.diagnostic?.safeToRetry, false);
      assert.equal(failure.value.diagnostic?.partials.toolCalls, 1);
    }
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

describe("M5: an unknown terminal failure is recorded as a redacted observation", () => {
  let obsHome: string;
  const savedHome = process.env.TREVOR_STATE_HOME;
  const savedConfig = process.env.TREVOR_HOME;

  beforeEach(() => {
    obsHome = mkdtempSync(join(tmpdir(), "trevor-recon-obs-"));
    process.env.TREVOR_STATE_HOME = obsHome;
    // Isolate the config home too, so the corpus migration never imports the developer's real store.
    process.env.TREVOR_HOME = join(obsHome, "config");
  });

  afterEach(() => {
    for (const [key, value] of [
      ["TREVOR_STATE_HOME", savedHome],
      ["TREVOR_HOME", savedConfig],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(obsHome, { recursive: true, force: true });
  });

  it.effect("records one unknown shape with the output-started flag and field names", () =>
    Effect.gen(function* () {
      const { exit } = yield* drive(flakyProvider({ failBefore: 1, error: unknownClassified }));
      assert.ok(Exit.isFailure(exit), "an unknown failure is still terminal");
      const store = yield* Effect.promise(() => readObservations());
      const summary = summarizeObservations(store);
      assert.equal(summary.distinct, 1, "exactly one observed shape");
      assert.equal(summary.unknown, 1, "classified unknown");
      const rec = Object.values(store)[0];
      assert.equal(rec?.kind, "provider_failure");
      assert.equal(rec?.shape.classification, "unknown");
      assert.equal(rec?.shape.outputStarted, false, "no token had streamed before the failure");
      assert.deepEqual(rec?.shape.fieldNames, ["error", "status"], "field NAMES only");
    }),
  );

  it.effect("a well-classified (non-retryable) failure is NOT observed", () =>
    Effect.gen(function* () {
      yield* drive(flakyProvider({ failBefore: 1, error: nonRetryable }));
      const store = yield* Effect.promise(() => readObservations());
      assert.equal(
        Object.keys(store).length,
        0,
        "model_unavailable carries its own action, not observed",
      );
    }),
  );
});

it.effect("the reconnect budget is bounded: all-failing goes terminal after the last attempt", () =>
  Effect.gen(function* () {
    // Always fails: attempts 1..10 each reconnect to the next, then attempt 10 goes terminal (02.15).
    const { events, exit } = yield* drive(flakyProvider({ failBefore: 99, error: retryable }));
    assert.ok(Exit.isFailure(exit), "the budget is spent and the turn goes terminal");
    assert.deepEqual(
      reconnects(events).map((e) => e.attempt),
      [2, 3, 4, 5, 6, 7, 8, 9, 10],
      "nine retries (ten total attempts), numbered through the budget, then terminal",
    );
    // The denominator is the full budget on every marker, including the last before terminal.
    assert.ok(
      reconnects(events).every((e) => e.maxAttempts === 10),
      "every marker carries the 10-attempt budget",
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

/**
 * Idle/stall watchdog (the 18-minute "Working" fix): a half-open stream that emits no event for
 * STREAM_STALL_MS (90s) is failed as a RETRYABLE outage, so it reconnects when nothing has streamed
 * yet, or goes terminal once tokens have flowed - never hangs forever. Driven with TestClock so the
 * 90s idle window is virtual; the fake provider HANGS (Stream.never) instead of failing.
 */
function hangingProvider(opts: { hangBefore: number; emitBeforeHang?: boolean }): Provider {
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
      if (calls <= opts.hangBefore) {
        return opts.emitBeforeHang
          ? Stream.concat(
              Stream.succeed<ProviderEvent>({ type: "text", text: "partial" }),
              Stream.never,
            )
          : Stream.never;
      }
      return Stream.fromIterable(ANSWER);
    },
  };
}

/** Drives the loop, advancing the TestClock past the 90s idle-stall window (+ the reconnect backoff). */
function driveStalled(provider: Provider) {
  return Effect.gen(function* () {
    const events: AgentEvent[] = [];
    const fiber = yield* Stream.runForEach(runAgent(provider, HISTORY, "off", "r1"), (e) =>
      Effect.sync(() => void events.push(e)),
    ).pipe(Effect.exit, Effect.fork);
    yield* TestClock.adjust(Duration.seconds(120));
    const exit = yield* Fiber.join(fiber);
    return { events, exit };
  });
}

it.effect("a stalled stream BEFORE the first token is retried (idle watchdog)", () =>
  Effect.gen(function* () {
    // The first call hangs (half-open); the watchdog fails it retryably, the loop reconnects, the
    // retry answers - exactly like a transient drop before output.
    const { events, exit } = yield* driveStalled(hangingProvider({ hangBefore: 1 }));
    assert.ok(Exit.isSuccess(exit), "the turn recovered after the stalled stream");
    assert.ok(reconnects(events).length >= 1, "the stall surfaced as a reconnect");
    assert.equal(answerText(events), "DONE", "the retry streamed the answer");
  }),
);

it.effect("a stalled stream AFTER output is terminal (no retry, like a mid-stream drop)", () =>
  Effect.gen(function* () {
    const { events, exit } = yield* driveStalled(
      hangingProvider({ hangBefore: 99, emitBeforeHang: true }),
    );
    assert.ok(Exit.isFailure(exit), "a stall after a token is terminal - the turn never hangs");
    assert.equal(reconnects(events).length, 0, "no reconnect once a token has streamed");
    assert.equal(answerText(events), "partial");
  }),
);
