import assert from "node:assert/strict";
import type { TrevorEventInput } from "@trevor/session";
import { Effect, Fiber, Stream } from "effect";
import { test } from "vitest";
import type { ChatMessage, Provider, ProviderEvent } from "../src/providers";
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

test("assistant.completed publishes typed stop metadata for an adaptive step backstop", async () => {
  // A 1M window at ~8.9% pressure earns the >=1M tier budget (96), so the backstop fires at 96, not the
  // old static 32, and the summary names the adaptive budget and its reason (D-021, D-025).
  const events = await runTurn(lowContextBackstopProvider(), history, { runId: "r1" });
  const completed = events.find((e) => e.type === "assistant.completed")?.payload;
  assert.equal(completed?.stepLimit, 96);
  assert.deepEqual(completed?.stop, {
    cause: "step_backstop",
    action: "paused",
    summary:
      "Paused at the adaptive 96-step budget before context pressure (>=1M context, 8.9% pressure -> 96 steps).",
    steps: 96,
    context: { inputTokens: 89_022, contextWindow: 1_000_000, pressure: 0.089022 },
  });
  assert.equal(completed?.text, "");
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
