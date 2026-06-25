import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessage } from "../src/providers";
import { fakeProvider, runTurn } from "./support/fake-provider";

/**
 * Agent-loop behaviors that don't depend on a real model, driven by the fake provider:
 * history threading into the model step, the context-floor guard, and the empty-answer retry.
 * These are the loop's correctness contracts the web transcript and the host's guards rely on.
 */

const usage = { input: 1, output: 1, contextWindow: 1000, genMs: 1 };

test("the turn pipeline forwards the full prior conversation to the model", async () => {
  const history: ChatMessage[] = [
    { role: "user", content: "Remember the number 42." },
    { role: "assistant", content: "OK." },
    { role: "user", content: "What number did I say?" },
  ];
  // A provider that answers immediately, echoing what it saw, proves the history reached it.
  const provider = fakeProvider({
    step: (messages) => [
      { type: "text", text: `saw ${messages.length} msgs; first=${messages[0]?.content ?? ""}` },
      { type: "usage", usage },
    ],
  });
  const events = await runTurn(provider, history, { runId: "r1" });
  const final = events.find((e) => e.type === "assistant.completed")?.payload;
  assert.ok(String(final?.text).includes("saw 3 msgs"), String(final?.text));
  assert.ok(String(final?.text).includes("Remember the number 42."));
});

test("a sub-minimum context window fails the turn before the model is ever called", async () => {
  let called = false;
  const provider = fakeProvider({
    capabilities: { images: false, tools: true, contextLength: 1000 }, // below the 16k floor
    step: () => {
      called = true;
      return [{ type: "text", text: "should not run" }];
    },
  });
  const events = await runTurn(provider, [{ role: "user", content: "hi" }], { runId: "r2" });
  const final = events.find((e) => e.type === "assistant.completed")?.payload;
  assert.equal(called, false, "the model must not be called below the context floor");
  assert.match(String(final?.error ?? ""), /minimum|context/i);
});

test("an empty answer is retried once, then surfaces as noReply (not a blank bubble)", async () => {
  let steps = 0;
  const provider = fakeProvider({
    step: () => {
      steps += 1;
      return [{ type: "usage", usage }]; // no text, no tool call -> empty
    },
  });
  const events = await runTurn(provider, [{ role: "user", content: "hi" }], { runId: "r3" });
  const final = events.find((e) => e.type === "assistant.completed")?.payload;
  assert.equal(final?.noReply, true);
  assert.ok(steps >= 2, `expected the one-shot retry; model was called ${steps}x`);
});
