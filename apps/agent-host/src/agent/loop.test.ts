import assert from "node:assert/strict";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import type { ChatMessage, Provider, ProviderEvent } from "../providers";
import { type AgentEvent, looksUnfinished, type RunAgentOptions, runAgent } from "./loop";

/**
 * Phase 2 (graceful turn-budget termination, D-051..D-053): a turn must never end silently
 * at the budget. These drive the loop with a fake provider that NEVER answers while tools
 * are offered (so it marches toward the budget) and answers only on the tools-removed
 * synthesis step - exercising the step backstop, the context-pressure gate, and the forced
 * final answer without any real model.
 */

const usage = (input: number, window: number) => ({
  input,
  output: 1,
  contextWindow: window,
  genMs: 1,
});

/**
 * A provider that loops forever on tool calls and answers only when tools are removed (the
 * synthesis step). `input`/`window` ride every usage event so a test can size the context
 * gate; `synthesisText` is what the forced answer returns (empty → exercises noReply).
 */
function loopingProvider(opts: {
  input: number;
  window: number;
  synthesisText?: string;
  repeatedTool?: boolean;
  onMessages?: (messages: readonly ChatMessage[], tools: number) => void;
}): Provider {
  let calls = 0;
  return {
    id: "fake",
    label: "Fake",
    model: "fake-1",
    reasoningLevels: ["off", "low"],
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => ({
      label: "Fake",
      model: "fake-1",
      reasoningLevels: ["off", "low"],
      defaultReasoning: "off",
      kind: "cloud",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (messages, tools) => {
      opts.onMessages?.(messages, tools.length);
      calls += 1;
      if (tools.length === 0) {
        // Synthesis step (tools removed): answer (or stay empty to test noReply).
        const text = opts.synthesisText ?? "FINAL ANSWER";
        const evs: ProviderEvent[] = [
          ...(text ? [{ type: "text" as const, text }] : []),
          { type: "usage", usage: usage(opts.input, opts.window) },
        ];
        return Stream.fromIterable(evs);
      }
      // Tool-calling step: call an unknown tool (executeTool returns an error string with no
      // process spawn) so the loop threads a result and recurses cheaply, never answering.
      return Stream.fromIterable<ProviderEvent>([
        {
          type: "tool_call",
          call: {
            id: `c${calls}`,
            name: "noop",
            arguments: opts.repeatedTool ? "{}" : JSON.stringify({ round: calls }),
          },
        },
        { type: "usage", usage: usage(opts.input, opts.window) },
      ]);
    },
  };
}

const collect = (provider: Provider, opts: RunAgentOptions = {}): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  return Effect.runPromise(
    Stream.runForEach(
      runAgent(provider, [{ role: "user", content: "go" }], "off", "r1", true, opts),
      (e) => Effect.sync(() => void events.push(e)),
    ),
  ).then(() => events);
};

test("M1+M2: DeepSeek-like low-context 32-step backstop pauses instead of forcing a normal answer", async () => {
  // Huge window so the context gate never fires - the turn runs to the MAX_STEPS backstop.
  const events = await collect(loopingProvider({ input: 89_022, window: 1_000_000 }));
  const limits = events.filter((e) => e.type === "step_limit");
  assert.equal(limits.length, 1, "exactly one step_limit");
  assert.equal((limits[0] as { steps: number }).steps, 32, "fires at the MAX_STEPS backstop");
  const stop = events.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "step_backstop");
  assert.equal(stop?.type === "stop" && stop.stop.action, "paused");
  assert.equal(stop?.type === "stop" && stop.stop.context?.pressure, 0.089022);
  const answer = events
    .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");
  assert.equal(answer, "", "the low-context backstop does not pose as a final answer");
  assert.ok(!events.some((e) => e.type === "empty"), "not an empty/noReply turn");
});

test("M3: the context gate stops early under a small window, later under a large one", async () => {
  // input 100 of a 100-token window = 100% >= 80%: after step 0's usage, step 1 synthesizes.
  const small = await collect(loopingProvider({ input: 100, window: 100 }));
  const smallSteps = (small.find((e) => e.type === "step_limit") as { steps: number }).steps;
  assert.equal(smallSteps, 1, "context gate fires after the first round, not at MAX_STEPS");
  const smallStop = small.find((e) => e.type === "stop");
  assert.equal(smallStop?.type === "stop" && smallStop.stop.cause, "context_pressure");
  assert.equal(smallStop?.type === "stop" && smallStop.stop.action, "synthesized");

  // input 100 of a 100k window = 0.1%: nowhere near the gate, so it runs to the backstop.
  const large = await collect(loopingProvider({ input: 100, window: 100_000 }));
  const largeSteps = (large.find((e) => e.type === "step_limit") as { steps: number }).steps;
  assert.equal(largeSteps, 32, "a roomy window runs to the backstop, not the context gate");
});

test("turn loop config overrides the step backstop per call", async () => {
  const events = await collect(loopingProvider({ input: 1, window: 1_000_000 }), {
    loop: { maxSteps: 3 },
  });
  const limit = events.find((e) => e.type === "step_limit");

  assert.equal(limit?.type === "step_limit" && limit.steps, 3);
});

test("M2: an empty context-pressure synthesis falls through to the empty path after step_limit", async () => {
  const events = await collect(loopingProvider({ input: 100, window: 100, synthesisText: "" }));
  assert.equal(events.filter((e) => e.type === "step_limit").length, 1);
  assert.ok(
    events.some((e) => e.type === "empty"),
    "an empty forced answer surfaces as empty -> noReply, never silence",
  );
});

/** A provider that returns text + usage (no tool call) on every step: `first` on the first call,
 *  `second` after - so a trailing-off first answer can be nudged into a real second one. */
function textProvider(opts: {
  first: string;
  second: string;
  providerId?: string;
  onMessages?: (messages: readonly ChatMessage[], tools: number) => void;
}): Provider {
  let calls = 0;
  return {
    id: opts.providerId ?? "fake",
    label: "Fake",
    model: "fake-1",
    reasoningLevels: ["off", "low"],
    defaultReasoning: "off",
    kind: "cloud",
    describe: () => ({
      label: "Fake",
      model: "fake-1",
      reasoningLevels: ["off", "low"],
      defaultReasoning: "off",
      kind: "cloud",
    }),
    readiness: () => Effect.succeed({ ready: true, warm: true }),
    capabilities: () => Effect.succeed({ images: false, tools: true, contextLength: 0 }),
    warm: () => Effect.void,
    stream: (messages, tools) => {
      opts.onMessages?.(messages, tools.length);
      calls += 1;
      const text = calls === 1 ? opts.first : opts.second;
      return Stream.fromIterable<ProviderEvent>([
        { type: "text", text },
        { type: "usage", usage: usage(10, 1_000_000) },
      ]);
    },
  };
}

test("looksUnfinished flags a trailing announcement, not a real final answer", () => {
  assert.equal(
    looksUnfinished("Let me continue reading the remaining source files:"),
    true,
    "a dangling colon - about to list/act, then stopped",
  );
  assert.equal(
    looksUnfinished("Now let me read the agent module files"),
    true,
    "a closing action clause with no tool call",
  );
  assert.equal(looksUnfinished("I'll go through the providers next"), true);
  assert.equal(
    looksUnfinished("Done. The entry point is src/main.ts."),
    false,
    "a real conclusion",
  );
  assert.equal(looksUnfinished("Here is a summary of what I found across the files."), false);
  assert.equal(looksUnfinished(""), false, "an empty answer is the noReply path, not this one");
});

test("a turn that trails off (text, no tool call) is nudged once to carry it out", async () => {
  let calls = 0;
  let secondPrompt = "";
  const events = await collect(
    textProvider({
      first: "Let me continue reading the remaining source files:",
      second: "All files read. The entry point is src/main.ts.",
      onMessages: (messages) => {
        calls += 1;
        if (calls === 2) {
          secondPrompt = messages.map((m) => m.content).join("\n");
        }
      },
    }),
  );
  assert.equal(calls, 2, "the model is re-called once after trailing off");
  assert.match(
    secondPrompt,
    /do not announce actions you do not take/i,
    "the nudge is in the prompt",
  );
  const text = events
    .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");
  assert.match(text, /entry point is src\/main\.ts/, "the turn continues to a real answer");
});

test("a genuine final answer (no trailing announcement) is NOT nudged", async () => {
  let calls = 0;
  await collect(
    textProvider({
      first: "All done. The entry point is src/main.ts.",
      second: "should-not-be-reached",
      onMessages: () => {
        calls += 1;
      },
    }),
  );
  assert.equal(calls, 1, "a real answer ends the turn with no extra model call");
});

test("provider-rendered tool markup stops as a protocol anomaly", async () => {
  const events = await collect(
    textProvider({
      providerId: "deepseek",
      first: '<tool_call>{"name":"read","arguments":{"path":"AGENTS.md"}}</tool_call>',
      second: "should-not-be-reached",
    }),
  );

  const stop = events.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "provider_protocol_anomaly");
  assert.equal(stop?.type === "stop" && stop.stop.action, "paused");
  assert.match(
    stop?.type === "stop" ? stop.stop.summary : "",
    /DeepSeek rendered raw tool-call markup/i,
  );
});

test("M2: the budget nudge reaches the model but is never emitted as an event", async () => {
  let synthesisPrompt = "";
  const events = await collect(
    loopingProvider({
      input: 100,
      window: 100,
      onMessages: (messages, tools) => {
        if (tools === 0) {
          synthesisPrompt = messages.map((m) => m.content).join("\n");
        }
      },
    }),
  );
  assert.match(synthesisPrompt, /tool-call budget/i, "the nudge is in the model's prompt");
  // The nudge is conversation-only: it must never ride out as a streamed text event (which
  // is what the durable history projection is rebuilt from).
  const emittedText = events
    .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");
  assert.doesNotMatch(emittedText, /tool-call budget/i, "the nudge is never emitted/persisted");
});

test("M1: a repeated-tool fixture represents a true loop stall", async () => {
  const events = await collect(
    loopingProvider({ input: 100, window: 1_000_000, repeatedTool: true }),
  );
  const stop = events.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "loop_stalled");
  assert.equal(stop?.type === "stop" && stop.stop.action, "paused");
});
