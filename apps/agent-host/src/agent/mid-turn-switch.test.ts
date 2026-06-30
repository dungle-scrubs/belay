import assert from "node:assert/strict";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import type { Provider, ProviderEvent } from "../providers";
import { type AgentEvent, runAgent } from "./loop";
import { createSwitchCell } from "./switch-cell";

/**
 * Plan 09.1 M1: the mid-turn switch mechanism. `runAgent` re-reads its model+reasoning from a per-turn
 * switch cell at each step boundary instead of freezing the value captured at turn start, so an external
 * switch requested while the turn is in flight lands on the NEXT step - never interrupting the open
 * model stream. These drive the loop with a fake provider that records the reasoning it is called with
 * on each step and pokes the cell from inside step 1's stream construction.
 */

/**
 * A provider that runs exactly two model steps: step 1 emits a tool call (so the loop threads a result
 * and recurses), step 2+ answers. `onStep(reasoning, call)` observes the reasoning arg the loop passed
 * for each step and is the hook a test uses to request a switch mid-turn.
 */
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
        ]);
      }
      return Stream.fromIterable<ProviderEvent>([{ type: "text", text: "done" }]);
    },
  };
}

const drive = (provider: Provider, cell = createSwitchCell()) =>
  Effect.runPromise(
    Stream.runForEach(
      runAgent(provider, [{ role: "user", content: "go" }], "off", "r1", true, {
        switch: cell,
        runTool: () => Effect.succeed("ok"),
      }),
      () => Effect.void,
    ),
  );

test("M1: a reasoning switch requested mid-turn is applied at the next step boundary", async () => {
  const seen: Array<string | undefined> = [];
  const cell = createSwitchCell();
  const provider = twoStepProvider((reasoning, call) => {
    seen.push(reasoning);
    // Request a switch to "high" while step 1's stream is being constructed; the loop must not apply it
    // to the open step, only to the next one.
    if (call === 1) {
      cell.request({ reasoning: "high", initiator: "manual" });
    }
  });
  await drive(provider, cell);
  assert.deepEqual(seen, ["off", "high"], "step 1 stays at off; the mid-turn switch lands on step 2");
});

test("M1: an in-flight model stream is never interrupted by a switch", async () => {
  // Step 1 emits text BEFORE its tool call; a switch requested between them must not truncate the open
  // stream - every event of step 1 still rides out, and the switch only affects step 2.
  const texts: string[] = [];
  const seen: Array<string | undefined> = [];
  const cell = createSwitchCell();
  let calls = 0;
  const provider: Provider = {
    ...twoStepProvider((reasoning) => seen.push(reasoning)),
    stream: (_messages, _tools, _reasoning) => {
      calls += 1;
      if (calls === 1) {
        cell.request({ reasoning: "high", initiator: "manual" });
        return Stream.fromIterable<ProviderEvent>([
          { type: "text", text: "mid-stream text" },
          { type: "tool_call", call: { id: "c1", name: "noop", arguments: "{}" } },
        ]);
      }
      return Stream.fromIterable<ProviderEvent>([{ type: "text", text: "done" }]);
    },
  };
  await Effect.runPromise(
    Stream.runForEach(
      runAgent(provider, [{ role: "user", content: "go" }], "off", "r1", true, {
        switch: cell,
        runTool: () => Effect.succeed("ok"),
      }),
      (e: AgentEvent) =>
        Effect.sync(() => {
          if (e.type === "text") {
            texts.push(e.text);
          }
        }),
    ),
  );
  assert.ok(
    texts.includes("mid-stream text"),
    "the open step's text streamed in full despite the switch request",
  );
  assert.ok(texts.includes("done"), "the next step ran after the switch");
});
