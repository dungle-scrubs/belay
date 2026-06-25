import assert from "node:assert/strict";
import type { TrevorEventInput } from "@trevor/session";
import { Effect, Fiber, Stream } from "effect";
import { test } from "vitest";
import type { ChatMessage, ProviderEvent } from "../src/providers";
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
