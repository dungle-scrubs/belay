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

test("44.4 M1: a provider limit ProviderEvent is published as one assistant.limit session event", async () => {
  // The provider surfaces a usage-limit signal mid-step (Claude's unified header path); the loop
  // forwards it and turn.ts publishes exactly one durable assistant.limit, carrying the turn's provider.
  const provider = fakeProvider({
    id: "anthropic",
    step: () => [
      { type: "limit", status: "approaching", scope: "five_hour", resetsAt: 1_780_000_000 },
      { type: "text", text: "still working" },
      { type: "usage", usage },
    ],
  });
  const events = await runTurn(provider, [{ role: "user", content: "hi" }], { runId: "r-lim" });
  const limits = events.filter((e) => e.type === "assistant.limit");
  assert.equal(limits.length, 1, "exactly one assistant.limit is emitted");
  assert.deepEqual(limits[0]?.payload, {
    provider: "anthropic",
    status: "approaching",
    scope: "five_hour",
    resetsAt: 1_780_000_000,
  });
});

test("44.4 M1: repeated identical limit signals in one turn are deduped per (provider,scope,status)", async () => {
  // A multi-step turn whose steps repeat the same approaching-five_hour header must not flood the
  // transcript - R-3 dedup. A DIFFERENT (scope,status) key still emits.
  let step = 0;
  const provider = fakeProvider({
    id: "anthropic",
    step: () => {
      step += 1;
      if (step === 1) {
        return [
          { type: "limit", status: "approaching", scope: "five_hour" },
          {
            type: "tool_call",
            call: { id: "c1", name: "bash", arguments: JSON.stringify({ command: "echo hi" }) },
          },
          { type: "usage", usage },
        ];
      }
      return [
        { type: "limit", status: "approaching", scope: "five_hour" }, // duplicate -> deduped
        { type: "limit", status: "reached", scope: "seven_day" }, // new key -> emitted
        { type: "text", text: "done" },
        { type: "usage", usage },
      ];
    },
  });
  const events = await runTurn(provider, [{ role: "user", content: "hi" }], { runId: "r-dedup" });
  const limits = events.filter((e) => e.type === "assistant.limit");
  assert.deepEqual(
    limits.map((e) => `${e.payload.status}:${e.payload.scope}`),
    ["approaching:five_hour", "reached:seven_day"],
  );
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
