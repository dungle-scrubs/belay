import assert from "node:assert/strict";
import type { TrevorEventInput } from "@trevor/session";
import { Effect, Fiber, Stream } from "effect";
import { test } from "vitest";
import type { ChatMessage, Provider, ProviderEvent } from "../src/providers";
import { providerIncidents } from "../src/providers";
import { ProviderUnavailable } from "../src/providers/errors";
import { publishTurn } from "../src/turn";
import { collectingEmit, fakeProvider, runTurn } from "./support/fake-provider";

/**
 * The turn pipeline end to end (provider Stream -> runAgent Stream -> publishTurn) with a
 * deterministic fake provider that calls a tool then answers. Exercises the multi-step loop,
 * real tool execution, the tool result threading back into the conversation, and the emitted
 * event sequence - the contract the web transcript binds to - without a live model. Ported
 * from scripts/verify-turn.ts.
 */

const history: ChatMessage[] = [{ role: "user", content: "Please run echo hello-from-tool." }];
const payloadOf = (events: TrevorEventInput[], type: string) =>
  events.find((e) => e.type === type)?.payload;

function lowContextBackstopProvider(): Provider {
  let calls = 0;
  return {
    id: "fake",
    label: "Fake",
    model: "fake-1",
    reasoningLevels: ["off"],
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => ({
      label: "Fake",
      model: "fake-1",
      reasoningLevels: ["off"],
      defaultReasoning: "off",
      kind: "cloud",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (_messages, tools) => {
      calls += 1;
      if (tools.length === 0) {
        return Stream.fromIterable<ProviderEvent>([
          { type: "text", text: "should not synthesize" },
        ]);
      }
      return Stream.fromIterable<ProviderEvent>([
        {
          type: "tool_call",
          call: {
            id: `c${calls}`,
            name: "noop",
            arguments: JSON.stringify({ round: calls }),
          },
        },
        { type: "usage", usage: { input: 89_022, output: 1, contextWindow: 1_000_000, genMs: 1 } },
      ]);
    },
  };
}

test("a turn streams started -> tool.started -> tool.completed -> completed, in order", async () => {
  const events = await runTurn(fakeProvider(), history, { runId: "r1" });
  const types = events.map((e) => e.type);

  assert.equal(types[0], "assistant.started");
  assert.ok(types.includes("tool.started"));
  assert.equal(payloadOf(events, "tool.started")?.name, "bash");
  assert.ok(
    types.indexOf("tool.started") < types.indexOf("tool.completed") &&
      types.indexOf("tool.completed") < types.lastIndexOf("assistant.completed"),
    types.join(" -> "),
  );
  assert.equal(events.filter((e) => e.type === "assistant.completed").length, 1);
});

test("the real tool runs and its output threads into the final answer", async () => {
  const events = await runTurn(fakeProvider(), history, { runId: "r1" });
  const toolResult = String(payloadOf(events, "tool.completed")?.result ?? "");
  assert.ok(toolResult.includes("hello-from-tool"), toolResult);

  const final = events.find((e) => e.type === "assistant.completed")?.payload;
  assert.equal(final?.error, undefined);
  const finalText = String(final?.text ?? "");
  assert.ok(
    finalText.includes("Let me run a command.") && finalText.includes("the tool ran."),
    finalText,
  );
});

test("one live progress snapshot per model step, each carrying usage + breakdown", async () => {
  const events = await runTurn(fakeProvider(), history, { runId: "r1" });
  const progress = events.filter((e) => e.type === "assistant.progress");
  assert.equal(progress.length, 2, `count=${progress.length}`); // two model steps here
  assert.ok(
    progress.every((e) => (e.payload.usage as { input?: number } | undefined)?.input === 10),
  );
  assert.ok(
    progress.every((e) => (e.payload.breakdown as { input?: unknown } | undefined)?.input != null),
  );
});

test("a flat-context turn pauses at the budget via the progress guard (02.17)", async () => {
  // A 1M window at ~8.9% pressure earns the >=1M tier budget (96). Context never grows (constant
  // 89_022 input every step), so at the first checkpoint the progress guard fails and the turn PAUSES
  // at 96 - the step backstop is no longer a hard pause, but an unproductive flat loop still stops.
  const events = await runTurn(lowContextBackstopProvider(), history, { runId: "r1" });
  const completed = events.find((e) => e.type === "assistant.completed")?.payload;
  assert.equal(completed?.stepLimit, 96);
  assert.deepEqual(completed?.stop, {
    cause: "step_backstop",
    action: "paused",
    summary:
      "Paused at step 96: context stopped advancing across the step-budget checkpoint (>=1M context, 8.9% pressure -> 96 steps).",
    steps: 96,
    context: { inputTokens: 89_022, contextWindow: 1_000_000, pressure: 0.089022 },
  });
  assert.equal(completed?.text, "");
  // No auto-continue breadcrumb: the guard failed at the first checkpoint, so it never continued.
  assert.equal(
    events.filter((e) => e.type === "assistant.continued").length,
    0,
    "a flat turn does not auto-continue",
  );
});

/**
 * A chatty-but-PRODUCTIVE model (the MiniMax-M3 case): it keeps emitting cheap tool calls whose
 * results GROW the prompt (low, slowly-rising context pressure), so the same-tool stall detector and
 * the context-pressure stop never fire. After `answerAfter` rounds it answers with text. Each step's
 * usage rises by `inputStep`, kept well under the window so pressure stays low.
 */
function chattyProvider(opts: {
  window: number;
  inputBase: number;
  inputStep: number;
  answerAfter: number;
}): Provider {
  let calls = 0;
  const describe = {
    label: "Fake",
    model: "fake-1",
    reasoningLevels: ["off"] as const,
    defaultReasoning: "off",
    kind: "cloud" as const,
  };
  return {
    id: "fake",
    ...describe,
    describe: () => describe,
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (_messages, tools) => {
      calls += 1;
      const input = opts.inputBase + calls * opts.inputStep;
      const usage: ProviderEvent = {
        type: "usage",
        usage: { input, output: 1, contextWindow: opts.window, genMs: 1 },
      };
      if (tools.length === 0 || calls > opts.answerAfter) {
        return Stream.fromIterable<ProviderEvent>([{ type: "text", text: "all done" }, usage]);
      }
      return Stream.fromIterable<ProviderEvent>([
        // Vary the args each round so the same-tool stall detector never fires - this models DIVERSE
        // productive work, the case the step budget (not the stall gate) governs.
        {
          type: "tool_call",
          call: { id: `c${calls}`, name: "noop", arguments: JSON.stringify({ round: calls }) },
        },
        usage,
      ]);
    },
  };
}

test("02.17: a chatty low-pressure turn auto-continues past the budget and finishes (breadcrumb)", async () => {
  // 32k window -> tier budget 32. Context grows each step, so at the budget the progress guard holds and
  // the turn AUTO-CONTINUES (one breadcrumb) instead of pausing, then answers a few steps later.
  const events = await runTurn(
    chattyProvider({ window: 32_000, inputBase: 1_000, inputStep: 200, answerAfter: 40 }),
    history,
    { runId: "r1" },
  );
  const continued = events.filter((e) => e.type === "assistant.continued");
  assert.ok(continued.length >= 1, "the turn auto-continued at least one checkpoint");
  assert.match(String(continued[0]?.payload.detail ?? ""), /continued at step 32/);
  const completed = events.find((e) => e.type === "assistant.completed")?.payload;
  assert.equal(completed?.text, "all done", "it finished the work past the old budget");
  assert.equal(completed?.stop, undefined, "no step_backstop pause - it continued and answered");
});

test("02.17: an unproductive chatty turn still terminates at the emergency ceiling", async () => {
  // Same growing context but it never answers; with a small emergency override the loop auto-continues
  // once, then the ABSOLUTE ceiling terminates the step axis (the runaway guard stays intact).
  const events = await runTurn(
    chattyProvider({ window: 32_000, inputBase: 1_000, inputStep: 200, answerAfter: 9_999 }),
    history,
    { runId: "r1", loop: { emergencyMaxSteps: 50 } },
  );
  assert.ok(
    events.filter((e) => e.type === "assistant.continued").length >= 1,
    "it auto-continued before the ceiling",
  );
  const completed = events.find((e) => e.type === "assistant.completed")?.payload;
  assert.equal((completed?.stop as { cause?: string } | undefined)?.cause, "step_backstop");
  assert.equal((completed?.stop as { steps?: number } | undefined)?.steps, 50);
  assert.match(
    String((completed?.stop as { summary?: string } | undefined)?.summary ?? ""),
    /emergency ceiling/,
  );
});

test("a terminal provider stream failure publishes structured diagnostic data with the legacy error", async () => {
  const provider = fakeProvider({
    id: "deepseek",
    stream: () =>
      Stream.concat(
        Stream.fromIterable<ProviderEvent>([
          { type: "text", text: "partial visible answer" },
          { type: "thinking", text: "hidden reasoning" },
        ]),
        Stream.fail(
          new ProviderUnavailable({
            provider: "deepseek",
            detail: "stream failed",
            retryable: true,
            classification: "transient_transport",
          }),
        ),
      ),
  });
  const events = await runTurn(provider, history, { runId: "r1" });
  const completed = events.find((e) => e.type === "assistant.completed")?.payload;

  assert.equal(completed?.error, "deepseek unavailable: stream failed");
  assert.equal((completed?.diagnostic as { phase?: string } | undefined)?.phase, "model-step");
  assert.equal(
    (completed?.diagnostic as { reason?: string } | undefined)?.reason,
    "transport_loss",
  );
  assert.equal((completed?.diagnostic as { retryable?: boolean } | undefined)?.retryable, true);
  assert.equal(
    (completed?.diagnostic as { safeToRetry?: boolean } | undefined)?.safeToRetry,
    false,
  );
  assert.deepEqual((completed?.diagnostic as { partials?: unknown } | undefined)?.partials, {
    textChars: "partial visible answer".length,
    thinkingChars: "hidden reasoning".length,
    toolCalls: 0,
    toolResults: 0,
  });
});

/**
 * A DeepSeek-style provider that renders raw tool-call markup as assistant TEXT instead of emitting a
 * typed tool call (the D-005 anomaly). `persistent: false` leaks once then answers cleanly on the
 * nudge re-run; `persistent: true` leaks every step so the bounded nudge is spent and the turn
 * terminates with a typed incident. Tools are offered (cloud kind), so the nudge path is eligible.
 */
function leakyProvider(opts: { persistent: boolean }): Provider {
  let calls = 0;
  const leak = '<｜tool▁calls｜>[{"name":"bash","arguments":"echo hi"}]<｜/tool▁calls｜>';
  const usage = { input: 10, output: 5, contextWindow: 1000, genMs: 1 };
  return fakeProvider({
    id: "deepseek",
    stream: () => {
      calls += 1;
      if (!opts.persistent && calls >= 2) {
        return Stream.fromIterable<ProviderEvent>([
          { type: "text", text: "Here is the real answer." },
          { type: "usage", usage },
        ]);
      }
      return Stream.fromIterable<ProviderEvent>([
        { type: "text", text: leak },
        { type: "usage", usage },
      ]);
    },
  });
}

test("a DeepSeek protocol-markup leak is nudged once, then the model answers cleanly", async () => {
  const events = await runTurn(leakyProvider({ persistent: false }), history, { runId: "r1" });
  const completed = events.find((e) => e.type === "assistant.completed")?.payload;

  assert.ok(
    String(completed?.text ?? "").includes("Here is the real answer."),
    String(completed?.text),
  );
  // The nudge recovered the turn: no anomaly stop and no diagnostic on the completion.
  assert.equal(completed?.stop, undefined);
  assert.equal(completed?.diagnostic, undefined);
});

test("a persistent DeepSeek protocol leak terminates with a protocol_anomaly diagnostic", async () => {
  const events = await runTurn(leakyProvider({ persistent: true }), history, { runId: "r1" });
  const completed = events.find((e) => e.type === "assistant.completed")?.payload;

  assert.equal(
    (completed?.stop as { cause?: string } | undefined)?.cause,
    "provider_protocol_anomaly",
  );
  const diagnostic = completed?.diagnostic as
    | { reason?: string; phase?: string; provider?: string; safeToRetry?: boolean }
    | undefined;
  assert.equal(diagnostic?.reason, "protocol_anomaly");
  assert.equal(diagnostic?.phase, "tool-protocol");
  assert.equal(diagnostic?.provider, "deepseek");
  assert.equal(diagnostic?.safeToRetry, false);
});

test("a persistent protocol leak records the provider's latest incident for /doctor", async () => {
  providerIncidents.reset();
  await runTurn(leakyProvider({ persistent: true }), history, { runId: "r1" });

  const incident = providerIncidents
    .latestByProvider()
    .find((i) => i.diagnostic.provider === "deepseek");
  assert.equal(incident?.diagnostic.reason, "protocol_anomaly");
  assert.equal(incident?.diagnostic.phase, "tool-protocol");
  assert.equal(incident?.runId, "r1");
});

test("a terminal transport failure records the latest incident with a redacted detail", async () => {
  providerIncidents.reset();
  const provider = fakeProvider({
    id: "deepseek",
    // Stream a token first so the failure is terminal immediately (no auto-reconnect on a partial).
    stream: () =>
      Stream.concat(
        Stream.fromIterable<ProviderEvent>([{ type: "text", text: "partial" }]),
        Stream.fail(
          new ProviderUnavailable({
            provider: "deepseek",
            detail: "stream failed; x-api-key: pi-7f2a91c4e3b8aa00bb11",
            retryable: true,
            classification: "transient_transport",
          }),
        ),
      ),
  });
  await runTurn(provider, history, { runId: "r9" });

  const incident = providerIncidents
    .latestByProvider()
    .find((i) => i.diagnostic.provider === "deepseek");
  assert.equal(incident?.diagnostic.reason, "transport_loss");
  assert.ok(
    !incident?.diagnostic.detail.includes("pi-7f2a91c4e3b8aa00bb11"),
    incident?.diagnostic.detail,
  );
});

test("cancellation interrupts a streaming turn before it completes", async () => {
  // A model step that emits one delta then never finishes: the only way the turn ends is by
  // interrupting its fiber, which is exactly how user.cancel stops a real turn (no AbortSignal
  // threaded through the pipeline - fiber interruption, A-004). Hermetic replacement for the
  // live-LM-Studio interrupt spike (scripts/spike-a004-interrupt.ts).
  const hanging = fakeProvider({
    stream: () =>
      Stream.concat(
        Stream.fromIterable<ProviderEvent>([{ type: "text", text: "x".repeat(60) }]),
        Stream.fromEffect(Effect.never),
      ),
  });
  const { layer, events } = collectingEmit();
  const fiber = Effect.runFork(
    publishTurn(hanging, history, { runId: "rx" }).pipe(Effect.provide(layer)),
  );

  // Wait until the first delta has streamed, then interrupt mid-turn.
  const deadline = Date.now() + 2000;
  while (!events.some((e) => e.type === "assistant.delta")) {
    if (Date.now() > deadline) throw new Error("turn never streamed a delta");
    await new Promise((r) => setTimeout(r, 10));
  }
  // Fiber.interrupt awaits the fiber's finalizers, so the onExit handler has run by the
  // time this resolves: an interrupted turn closes with exactly one cancelled completion
  // (never a clean one), so the web transcript can finalize the bubble.
  await Effect.runPromise(Fiber.interrupt(fiber));

  const completed = events.filter((e) => e.type === "assistant.completed");
  assert.equal(completed.length, 1, events.map((e) => e.type).join(" -> "));
  assert.equal(completed[0]?.payload.cancelled, true);
});
