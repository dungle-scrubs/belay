import assert from "node:assert/strict";
import { publishTurn } from "@host/agent/turn";
import type { ChatMessage, Provider, ProviderEvent, ToolDef } from "@host/providers";
import { buildSystemPrompt } from "@host/providers/system-prompt";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import { createSwitchCell } from "../src/agent/switch-cell";
import { collectingEmit } from "./support/fake-provider";

/**
 * Plan 50 M4: a mid-turn model switch (09.1) to a different-window model re-tiers the NEXT step's
 * system prompt. Hermetic - no LM Studio/cloud. Each provider builds its prompt at its OWN served
 * window inside stream() exactly as streamPiAiModel does in production, and records it; when the loop
 * swaps the large-window model for a small-window one at the step boundary, the recorded post-switch
 * prompt is the leaner tier. Characterizes the composition: because the prompt is rebuilt per step and
 * `currentProvider` is swapped on the switch, the re-tier needs no new re-read boundary (D-003).
 */

const HISTORY: ChatMessage[] = [{ role: "user", content: "go" }];

// A distinctive phrase from the full-tier MCP guidance block, dropped below the full tier.
const FULL_TIER_MARKER = "The mcp tool talks to the user's configured MCP servers";

/** A provider that, on each step, builds its system prompt at its own served window (mirroring
 *  streamPiAiModel) and appends it to `capture`, then runs `onStep` and streams `events`. */
function recordingProvider(opts: {
  readonly id: string;
  readonly contextWindow: number;
  readonly capture: string[];
  readonly onStep?: (call: number) => void;
  readonly events: (call: number) => readonly ProviderEvent[];
}): Provider {
  let calls = 0;
  const descriptor = {
    label: opts.id,
    model: opts.id,
    reasoningLevels: [] as readonly string[],
    defaultReasoning: "off",
    kind: "cloud" as const,
  };
  return {
    id: opts.id,
    label: opts.id,
    model: opts.id,
    reasoningLevels: [],
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => descriptor,
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (_messages: readonly ChatMessage[], tools: readonly ToolDef[]) => {
      calls += 1;
      opts.capture.push(buildSystemPrompt(tools, { contextWindow: opts.contextWindow }));
      opts.onStep?.(calls);
      return Stream.fromIterable<ProviderEvent>([...opts.events(calls)]);
    },
  };
}

test("M4: a mid-turn switch to a smaller-window model re-tiers the next step's prompt", async () => {
  const capture: string[] = [];
  const cell = createSwitchCell();

  // The swapped-in model serves an 8k window -> the minimal tier.
  const providerB = recordingProvider({
    id: "model-b",
    contextWindow: 8_000,
    capture,
    events: () => [
      { type: "text", text: "done" },
      { type: "usage", usage: { input: 10, output: 1, contextWindow: 8_000, genMs: 1 } },
    ],
  });

  // The starting model serves a 200k window -> the full tier; step 1 calls a tool and requests the swap.
  const providerA = recordingProvider({
    id: "model-a",
    contextWindow: 200_000,
    capture,
    onStep: (call) => {
      if (call === 1) {
        cell.request({
          model: { sourceId: "s", modelId: "model-b", reasoning: null },
          initiator: "manual",
        });
      }
    },
    events: (call) =>
      call === 1
        ? [
            { type: "tool_call", call: { id: "c1", name: "noop", arguments: "{}" } },
            { type: "usage", usage: { input: 10, output: 1, contextWindow: 200_000, genMs: 1 } },
          ]
        : [
            { type: "text", text: "from-a" },
            { type: "usage", usage: { input: 10, output: 1, contextWindow: 200_000, genMs: 1 } },
          ],
  });

  const { layer, events } = collectingEmit();
  await Effect.runPromise(
    publishTurn(providerA, HISTORY, {
      runId: "r1",
      switchSurface: {
        cell,
        rebuildProvider: (model) => (model.modelId === "model-b" ? providerB : null),
      },
    }).pipe(Effect.provide(layer)),
  );

  // One prompt per model step: step 1 on the 200k model, step 2 on the swapped-in 8k model.
  assert.equal(capture.length, 2, "exactly one prompt built per step");
  assert.ok(
    capture[0]?.includes(FULL_TIER_MARKER),
    "step 1 built the full-tier prompt (200k window)",
  );
  assert.ok(
    !capture[1]?.includes(FULL_TIER_MARKER),
    "step 2 re-tiered to the leaner prompt after switching to the 8k model",
  );
  assert.ok(capture[1]?.includes("You are Trevor"), "the leaner post-switch prompt is well-formed");

  const switched = events.find((e) => e.type === "model.switched");
  assert.equal(switched?.payload.outcome, "applied", "the mid-turn model switch applied");
});
