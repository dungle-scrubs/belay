import assert from "node:assert/strict";
import type { ChatMessage } from "@host/providers";
import type { SystemPromptContext } from "@host/providers/system-prompt";
import { Effect } from "effect";
import { test, vi } from "vitest";
import { collectingEmit, fakeProvider } from "./support/fake-provider";

/**
 * Plan 50 M1/M3: the turn's breakdown-seed prompt build threads the route data (the served-window
 * estimate + the model capabilities) into `SystemPromptContext`, so the fixed-overhead seed measures
 * the tier the model will actually receive rather than a context-blind full prompt. Spies the builder
 * to capture the context the seed passes. Pre-stream the served window is unknown, so the seed uses the
 * provider's native ceiling (`capabilities.contextLength`) as the estimate.
 */

const { buildSpy } = vi.hoisted(() => ({
  buildSpy: vi.fn<(context: SystemPromptContext) => void>(),
}));

vi.mock("@host/providers/system-prompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@host/providers/system-prompt")>();
  return {
    ...actual,
    buildSystemPrompt: (tools: Parameters<typeof actual.buildSystemPrompt>[0], context = {}) => {
      buildSpy(context);
      return actual.buildSystemPrompt(tools, context);
    },
  };
});

// Imported after the hoisted mock so turn.ts binds the wrapped builder.
const { publishTurn } = await import("@host/agent/turn");

const HISTORY: ChatMessage[] = [{ role: "user", content: "go" }];

test("M1: the breakdown seed threads the served-window estimate + capabilities into the prompt build", async () => {
  buildSpy.mockClear();
  // Above the 16k minimum-to-run guard (turn-preflight.ts) so the turn is not blocked; the seed then
  // estimates the served window from this native ceiling.
  const capabilities = { images: false, tools: true, contextLength: 20_000 };
  const provider = fakeProvider({
    capabilities,
    step: () => [
      { type: "text", text: "hi" },
      { type: "usage", usage: { input: 10, output: 5, contextWindow: 20_000, genMs: 1 } },
    ],
  });
  const { layer } = collectingEmit();
  await Effect.runPromise(
    publishTurn(provider, HISTORY, { runId: "r1" }).pipe(Effect.provide(layer)),
  );

  // The fake provider builds no prompt of its own, so the only build is the turn.ts breakdown seed.
  assert.ok(buildSpy.mock.calls.length >= 1, "the seed built a system prompt");
  const seedContext = buildSpy.mock.calls[0]?.[0];
  assert.equal(
    seedContext?.contextWindow,
    20_000,
    "the seed uses the provider's native window as the pre-stream served estimate",
  );
  assert.deepEqual(
    seedContext?.capabilities,
    capabilities,
    "the seed threads the model capabilities alongside the window",
  );
});
