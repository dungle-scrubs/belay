import assert from "node:assert/strict";
import {
  type ChatMessage,
  collectingEmit,
  createSwitchCell,
  type Provider,
  type ProviderEvent,
  publishTurn,
} from "@trevor/agent-host/testing";
import { Effect, Stream } from "effect";
import { test } from "vitest";

/**
 * S-SWITCH (plan 09.1, hermetic): the mid-turn model-switch runtime end to end, the exact path the host
 * drives - a switch control event routed into the turn's cell, the loop re-resolving at each step
 * boundary, and the durable `model.switched` events the transcript marker folds. One turn walks all three
 * switch kinds in order (reasoning-only -> same-provider model -> cross-provider model) on a fake multi-
 * provider harness, asserting the markers + conversation continuity; a second turn drives the blocked
 * larger->smaller guard. No live model. The UI render is a deferred manual EZE (09.2 browser suite).
 */

const usage = { input: 1_000, output: 1, contextWindow: 1_000_000, genMs: 1 };
const toolStep = (id: string): ProviderEvent[] => [
  { type: "tool_call", call: { id, name: "noop", arguments: "{}" } },
  { type: "usage", usage },
];
const answer = (text: string): ProviderEvent[] => [
  { type: "text", text },
  { type: "usage", usage },
];

function provider(
  source: string,
  model: string,
  behave: (call: number) => ProviderEvent[],
  seen?: (messages: readonly ChatMessage[]) => void,
): Provider {
  let calls = 0;
  return {
    id: source,
    label: model,
    model,
    reasoningLevels: ["off", "low", "high"],
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => ({
      label: model,
      model,
      reasoningLevels: ["off", "low", "high"],
      defaultReasoning: "off",
      kind: "cloud",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (messages, _tools, _reasoning) => {
      calls += 1;
      seen?.(messages);
      return Stream.fromIterable<ProviderEvent>(behave(calls));
    },
  };
}

const history: ChatMessage[] = [{ role: "user", content: "go" }];

test("one turn walks reasoning -> same-provider model -> cross-provider, recording each switch", async () => {
  const cell = createSwitchCell();
  let bMessages: readonly ChatMessage[] = [];
  // Step 4 runs on cross-provider B; it captures the carried (normalized) conversation.
  const providerB = provider(
    "source-b",
    "model-b",
    () => answer("final"),
    (m) => {
      bMessages = m;
    },
  );
  const providerA2 = provider("source-a", "model-a2", (call) => {
    if (call === 1) {
      // Step 3: same-source swap landed; now request a CROSS-provider swap to source-b.
      cell.request({
        model: { sourceId: "source-b", modelId: "model-b", reasoning: "high" },
        initiator: "manual",
      });
      return toolStep("c3");
    }
    return answer("unreached");
  });
  const providerA = provider("source-a", "model-a", (call) => {
    if (call === 1) {
      // Step 1 ran at reasoning "low"; request a reasoning-only switch to "high".
      cell.request({ reasoning: "high", initiator: "manual" });
      return toolStep("c1");
    }
    // Step 2 runs at "high"; request a SAME-source model swap to model-a2.
    cell.request({
      model: { sourceId: "source-a", modelId: "model-a2", reasoning: "high" },
      initiator: "manual",
    });
    return toolStep("c2");
  });

  const { layer, events } = collectingEmit();
  await Effect.runPromise(
    publishTurn(providerA, history, {
      runId: "r1",
      reasoning: "low",
      switch: cell,
      rebuildProvider: (model) =>
        model.modelId === "model-a2" ? providerA2 : model.modelId === "model-b" ? providerB : null,
    }).pipe(Effect.provide(layer)),
  );

  const switches = events
    .filter((e) => e.type === "model.switched")
    .map(
      (e) =>
        e.payload as {
          from: { model: string; reasoning?: string };
          to: { model: string; reasoning?: string };
          outcome: string;
        },
    );
  assert.equal(switches.length, 3, "three switches recorded in one turn");
  // Reasoning-only: same model, low -> high.
  assert.deepEqual(switches[0]?.from, { model: "model-a", reasoning: "low" });
  assert.deepEqual(switches[0]?.to, { model: "model-a", reasoning: "high" });
  // Same-provider model swap: model-a -> model-a2, reasoning carried.
  assert.deepEqual(switches[1]?.to, { model: "model-a2", reasoning: "high" });
  // Cross-provider swap: model-a2 -> model-b.
  assert.deepEqual(switches[2]?.to, { model: "model-b", reasoning: "high" });
  assert.deepEqual(
    switches.map((s) => s.outcome),
    ["applied", "applied", "applied"],
  );

  // Continuity: provider B replays the full carried conversation, with cross-provider-normalized tool ids.
  const toolResults = bMessages.filter((m) => m.role === "tool");
  assert.ok(
    toolResults.length >= 3,
    "the cross-provider model sees every prior step's tool result",
  );
  assert.ok(
    toolResults.every((m) => /^call_\d+$/u.test(m.toolCallId ?? "")),
    "carried tool ids were normalized to the neutral scheme for the new provider",
  );

  const final = events.find((e) => e.type === "assistant.completed");
  assert.equal(
    String(final?.payload.text ?? ""),
    "final",
    "the final answer came from the swapped-in model",
  );
});

test("a larger->smaller switch that does not fit is blocked, the turn finishes on the original model", async () => {
  const cell = createSwitchCell();
  let rebuilt = 0;
  const big = provider("source-a", "big-model", (call) => {
    if (call === 1) {
      // The conversation measured ~500k tokens; the target's 8k window can't hold it.
      cell.request({
        model: { sourceId: "source-b", modelId: "small-model", reasoning: "high" },
        initiator: "manual",
        targetWindow: 8_000,
      });
      return [
        { type: "tool_call", call: { id: "c1", name: "noop", arguments: "{}" } },
        { type: "usage", usage: { input: 500_000, output: 1, contextWindow: 1_000_000, genMs: 1 } },
      ];
    }
    return answer("done-on-big");
  });

  const { layer, events } = collectingEmit();
  await Effect.runPromise(
    publishTurn(big, history, {
      runId: "r2",
      reasoning: "high",
      switch: cell,
      rebuildProvider: () => {
        rebuilt += 1;
        return null;
      },
    }).pipe(Effect.provide(layer)),
  );

  const blocked = events.find((e) => e.type === "model.switched");
  assert.equal((blocked?.payload as { outcome: string } | undefined)?.outcome, "blocked");
  assert.match(
    String((blocked?.payload as { reason?: string } | undefined)?.reason ?? ""),
    /context window/,
  );
  assert.equal(rebuilt, 0, "a blocked switch never rebuilds the provider");
  const final = events.find((e) => e.type === "assistant.completed");
  assert.equal(
    String(final?.payload.text ?? ""),
    "done-on-big",
    "the turn finished on the original model",
  );
});
