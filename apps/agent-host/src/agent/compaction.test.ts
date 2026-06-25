import assert from "node:assert/strict";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import type { Provider, ProviderEvent } from "../providers";
import { buildSummaryPrompt, summarize } from "./compaction";

/**
 * Phase 3 (cross-turn compaction, D-043): the tool-less rolling-summary generator. These drive
 * `summarize` with a fake provider that returns a fixed body, asserting the call is tool-less, the
 * result is capped to the ~1k-token budget, and the prompt folds the prior summary + turns without
 * restating the pinned goal/tasks.
 */

function fakeProvider(opts: {
  text?: string;
  /** Stream the summary as several text events (one per chunk), to exercise streaming progress. */
  chunks?: readonly string[];
  reasoningLevels?: readonly string[];
  capture?: (messages: number, tools: number, reasoning: string | undefined) => void;
}): Provider {
  const reasoningLevels = opts.reasoningLevels ?? ["off", "low"];
  return {
    id: "fake",
    label: "Fake",
    model: "fake-1",
    reasoningLevels,
    defaultReasoning: reasoningLevels[0] ?? "off",
    kind: "cloud",
    describe: () => ({
      label: "Fake",
      model: "fake-1",
      reasoningLevels,
      defaultReasoning: reasoningLevels[0] ?? "off",
      kind: "cloud",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (messages, tools, reasoning) => {
      opts.capture?.(messages.length, tools.length, reasoning);
      const chunks = opts.chunks ?? [opts.text ?? ""];
      return Stream.fromIterable<ProviderEvent>(chunks.map((text) => ({ type: "text", text })));
    },
  };
}

test("summarize caps the rolling summary to the ~1k-token budget", async () => {
  // The summary rides in every later prompt, so an overrun is truncated to the ~4k-char backstop.
  const summary = await Effect.runPromise(
    summarize(fakeProvider({ text: "x".repeat(10_000) }), {
      priorSummary: null,
      foldedTurns: [{ role: "user", content: "a" }],
    }),
  );
  assert.equal(summary.length, 4_000, "capped to ~1k tokens (~4k chars)");
});

test("summarize calls the model tool-less, with reasoning forced to the cheapest level", async () => {
  let tools = -1;
  let reasoning: string | undefined = "unset";
  await Effect.runPromise(
    summarize(
      fakeProvider({
        text: "ok",
        capture: (_m, t, r) => {
          tools = t;
          reasoning = r;
        },
      }),
      { priorSummary: null, foldedTurns: [{ role: "user", content: "a" }] },
    ),
  );
  assert.equal(tools, 0, "no tools are offered to the summarizer");
  assert.equal(reasoning, "off", "reasoning forced off when the provider supports it");
});

test("summarize falls back to the lowest reasoning level when the provider has no 'off'", async () => {
  let reasoning: string | undefined = "unset";
  await Effect.runPromise(
    summarize(
      fakeProvider({
        text: "ok",
        reasoningLevels: ["minimal", "high"],
        capture: (_m, _t, r) => {
          reasoning = r;
        },
      }),
      { priorSummary: null, foldedTurns: [{ role: "user", content: "a" }] },
    ),
  );
  assert.equal(reasoning, "minimal", "lowest level when 'off' is unavailable");
});

test("the prompt folds prior summary + turns and forbids restating the goal/tasks", () => {
  const messages = buildSummaryPrompt({
    priorSummary: "earlier summary",
    foldedTurns: [
      { role: "user", content: "do X" },
      { role: "assistant", content: "did X" },
    ],
  });
  assert.equal(messages.length, 1);
  const content = messages[0]?.content ?? "";
  assert.match(content, /Do NOT restate the original goal or the task list/);
  assert.match(content, /key decisions/);
  assert.match(content, /earlier summary/);
  assert.match(content, /user: do X/);
  assert.match(content, /assistant: did X/);
});

test("summarize reports honest streaming progress: tokens grow toward the budget", async () => {
  const ticks: Array<{ tokens: number; budget: number }> = [];
  await Effect.runPromise(
    summarize(
      // Three 40-char chunks → 10, 20, 30 tokens cumulatively (~4 chars/token).
      fakeProvider({ chunks: ["abcd".repeat(10), "efgh".repeat(10), "ijkl".repeat(10)] }),
      { priorSummary: null, foldedTurns: [{ role: "user", content: "x" }] },
      (tokens, budget) => ticks.push({ tokens, budget }),
    ),
  );
  assert.deepEqual(
    ticks.map((t) => t.tokens),
    [0, 10, 20, 30],
    "an immediate 0 tick (so the bar appears at once), then growth with streamed output",
  );
  assert.equal(ticks.at(-1)?.budget, 1_000, "the budget is the ~1k-token cap");
});

test("summarize stops generating once the summary reaches its budget (no overrun on slow models)", async () => {
  // 20 chunks of ~100 tokens each = ~2000 tokens if fully streamed. The stream must stop at the
  // ~1k-token budget instead of letting a slow local model overrun it (which would pin the progress
  // bar at 100% for many extra seconds of wasted generation).
  const ticks: number[] = [];
  const chunk = "x".repeat(400); // 400 chars ≈ 100 tokens
  const summary = await Effect.runPromise(
    summarize(
      fakeProvider({ chunks: Array.from({ length: 20 }, () => chunk) }),
      { priorSummary: null, foldedTurns: [{ role: "user", content: "x" }] },
      (tokens) => ticks.push(tokens),
    ),
  );
  assert.equal(ticks[0], 0, "an immediate tick fires before any output streams");
  assert.equal(ticks.at(-1), 1_000, "progress stops exactly at the budget");
  assert.equal(
    ticks.length - 1,
    10,
    "10 chunks stream up to the budget (rest skipped), after the 0 tick",
  );
  assert.equal(summary.length, 4_000, "the result is the budget-capped prefix");
});

test("the first fold omits the previous-summary section", () => {
  const content = buildSummaryPrompt({
    priorSummary: null,
    foldedTurns: [{ role: "user", content: "hi" }],
  })[0]?.content;
  assert.doesNotMatch(content ?? "", /\[Previous summary\]/);
});
