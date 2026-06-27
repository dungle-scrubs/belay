import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { test } from "vitest";
import type { QueuedPrompt } from "@/send-queue";
import { useSendQueue } from "./use-send-queue";

/**
 * The send-queue React glue (the reducer + fold rules are unit-tested in send-queue.test.ts;
 * this drives the hook in a DOM). Guards the two invariants the inline App version was lifted
 * to protect: drain one-prompt-at-a-time with no double-send, and hard-steer folding the queue
 * + draft into a single prompt. S-WEB-4 / S-WEB-5.
 */

const prompt = (id: string, text: string): QueuedPrompt => ({ id, text, provider: "qwen" });

test("drains one prompt at a time and never double-sends", async () => {
  const published: string[] = [];
  const publish = async (text: string) => {
    published.push(text);
  };

  let busy = false;
  const { result, rerender } = renderHook(() => useSendQueue({ busy, publish }));

  // Two prompts submitted while idle: only the head publishes; the second waits behind the
  // in-flight latch even though the session is still (briefly) idle.
  act(() => result.current.submit(prompt("1", "first")));
  act(() => result.current.submit(prompt("2", "second")));
  assert.deepEqual(published, ["first"]);
  assert.equal(result.current.pending?.text, "first");
  assert.deepEqual(
    result.current.queue.map((p) => p.text),
    ["second"],
  );

  // The turn runs (busy goes high) then ends (busy goes low): the release effect frees the
  // latch and the drain effect publishes the second prompt - now, and only now.
  busy = true;
  rerender();
  assert.equal(Boolean(result.current.pending), false);
  busy = false;
  rerender();
  assert.deepEqual(published, ["first", "second"]);
  assert.equal(result.current.pending?.text, "second");
  assert.deepEqual(result.current.queue, []);
});

test("a submitted prompt's ModelRef is forwarded to publish (D-065)", () => {
  const calls: Array<{ text: string; model: unknown }> = [];
  const publish = async (
    text: string,
    _provider: string,
    _reasoning?: string,
    _artifacts?: unknown,
    model?: unknown,
  ) => {
    calls.push({ text, model });
  };
  const model = { sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "high" };
  const { result } = renderHook(() => useSendQueue({ busy: false, publish }));
  act(() => result.current.submit({ id: "1", text: "hi", provider: "deepseek", model }));
  assert.deepEqual(calls, [{ text: "hi", model }], "the snapshot ModelRef reaches publish");
});

test("hard steer folds the queued prompts + draft into a single prompt", () => {
  const publish = async () => {};
  // Busy throughout, so the submits accumulate in the queue instead of draining.
  const { result } = renderHook(() => useSendQueue({ busy: true, publish }));

  act(() => result.current.submit(prompt("1", "first")));
  act(() => result.current.submit(prompt("2", "second")));
  act(() => result.current.steer("a third thought", [], { id: "s", provider: "qwen" }));

  assert.equal(result.current.queue.length, 1);
  const folded = result.current.queue[0]?.text ?? "";
  assert.ok(
    folded.includes("first") && folded.includes("second") && folded.includes("a third thought"),
    folded,
  );
});

test("session changes clear queued prompts and the in-flight latch", () => {
  const published: string[] = [];
  const publish = async (text: string) => {
    published.push(text);
  };
  const { result, rerender } = renderHook(
    ({ sessionId }: { sessionId: string }) =>
      useSendQueue({ busy: true, publish, resetKey: sessionId }),
    { initialProps: { sessionId: "s1" } },
  );

  act(() => result.current.submit(prompt("1", "old directory prompt")));
  assert.equal(result.current.queue.length, 1);

  rerender({ sessionId: "s2" });
  assert.equal(result.current.pending, null);
  assert.deepEqual(result.current.queue, []);

  act(() => result.current.submit(prompt("2", "new directory prompt")));
  assert.equal(result.current.queue.length, 1);
  assert.deepEqual(published, []);
});
