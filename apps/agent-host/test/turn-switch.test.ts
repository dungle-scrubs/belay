import assert from "node:assert/strict";
import type { TrevorEventInput } from "@trevor/session";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import { createSwitchCell } from "../src/agent/switch-cell";
import type { ChatMessage, Provider, ProviderEvent } from "../src/providers";
import { publishTurn } from "../src/turn";
import { collectingEmit } from "./support/fake-provider";

/**
 * Plan 09.1 M2: a mid-turn switch routed into the turn's cell surfaces as a durable `model.switched`
 * session event carrying from/to model+reasoning, initiator, and outcome. Phase 1 covers a reasoning-only
 * change (the model is unchanged on both sides). Drives the real turn pipeline (publishTurn -> runAgent)
 * with a fake provider that pokes the cell from inside its first step.
 */

/** A two-step provider: step 1 calls a tool (so the loop recurses), step 2 answers. It records the
 *  reasoning it was called with and runs `onStep` so a test can request a switch mid-turn. */
function twoStepProvider(onStep: (reasoning: string | undefined, call: number) => void): Provider {
  let calls = 0;
  const levels = ["off", "low", "high"];
  return {
    id: "fake",
    label: "Fake",
    model: "fake-1",
    reasoningLevels: levels,
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => ({
      label: "Fake",
      model: "fake-1",
      reasoningLevels: levels,
      defaultReasoning: "off",
      kind: "cloud",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (_messages, _tools, reasoning) => {
      calls += 1;
      onStep(reasoning, calls);
      if (calls === 1) {
        return Stream.fromIterable<ProviderEvent>([
          { type: "tool_call", call: { id: "c1", name: "noop", arguments: "{}" } },
          { type: "usage", usage: { input: 10, output: 1, contextWindow: 1_000_000, genMs: 1 } },
        ]);
      }
      return Stream.fromIterable<ProviderEvent>([
        { type: "text", text: "done" },
        { type: "usage", usage: { input: 10, output: 1, contextWindow: 1_000_000, genMs: 1 } },
      ]);
    },
  };
}

const history: ChatMessage[] = [{ role: "user", content: "go" }];

async function runWith(provider: Provider, cell = createSwitchCell()): Promise<TrevorEventInput[]> {
  const { layer, events } = collectingEmit();
  await Effect.runPromise(
    publishTurn(provider, history, { runId: "r1", reasoning: "off", switch: cell }).pipe(
      Effect.provide(layer),
    ),
  );
  return events;
}

test("M2: a reasoning switch routed mid-turn emits one model.switched (from/to reasoning, applied)", async () => {
  const cell = createSwitchCell();
  const seen: Array<string | undefined> = [];
  const events = await runWith(
    twoStepProvider((reasoning, call) => {
      seen.push(reasoning);
      if (call === 1) {
        cell.request({ reasoning: "high", initiator: "manual" });
      }
    }),
    cell,
  );
  const switched = events.filter((e) => e.type === "model.switched");
  assert.equal(switched.length, 1, "exactly one model.switched for the single switch");
  assert.deepEqual(switched[0]?.payload, {
    runId: "r1",
    from: { model: "fake-1", reasoning: "off" },
    to: { model: "fake-1", reasoning: "high" },
    initiator: "manual",
    outcome: "applied",
  });
  assert.deepEqual(seen, ["off", "high"], "step 2 ran under the switched reasoning");
});

test("M2: no switch requested means no model.switched event (idle is a no-op)", async () => {
  const events = await runWith(twoStepProvider(() => {}));
  assert.equal(
    events.filter((e) => e.type === "model.switched").length,
    0,
    "a turn with no switch request publishes no model.switched",
  );
});
