import assert from "node:assert/strict";
import { SPAN_NAMES } from "@trevor/session/telemetry";
import { recordingTelemetrySink } from "@trevor/test-kit";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import type { ChatMessage, Provider, ProviderEvent } from "../providers";
import {
  type AgentEvent,
  looksUnfinished,
  type RunAgentOptions,
  runAgent,
  withToolStallTimeout,
} from "./loop";

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

test("M3: a 1M-context low-pressure loop runs past 32 to the large-context budget, then pauses", async () => {
  // Huge window, ~8.9% pressure: the context gate never fires and the old static 32-step cap is gone,
  // so the adaptive >=1M tier budget (96) governs - exactly the DeepSeek-V4-Pro case from the RFC.
  const events = await collect(loopingProvider({ input: 89_022, window: 1_000_000 }));
  const limits = events.filter((e) => e.type === "step_limit");
  assert.equal(limits.length, 1, "exactly one step_limit");
  assert.equal(
    (limits[0] as { steps: number }).steps,
    96,
    "a low-pressure 1M turn runs to the large-context budget, not the old 32",
  );
  const stop = events.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "step_backstop");
  assert.equal(stop?.type === "stop" && stop.stop.action, "paused");
  assert.equal(stop?.type === "stop" && stop.stop.context?.pressure, 0.089022);
  // 02.17: the step backstop is now a checkpoint. This provider's context is FLAT (constant input), so
  // the first checkpoint's progress guard fails and the turn pauses at the budget (96) - now named for
  // the failed progress guard rather than a static backstop. A productive (growing) turn would continue.
  assert.match(
    stop?.type === "stop" ? stop.stop.summary : "",
    /context stopped advancing across the step-budget checkpoint/,
    "the pause names the progress guard, not a static backstop",
  );
  // A flat turn does not auto-continue: no checkpoint breadcrumb was emitted.
  assert.equal(
    events.filter((e) => e.type === "checkpoint").length,
    0,
    "a flat-context turn pauses rather than auto-continuing",
  );
  const answer = events
    .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");
  assert.equal(answer, "", "the backstop does not pose as a final answer");
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

test("the emergency ceiling clamps the adaptive budget per call", async () => {
  // A low emergency override wins over the generous 1M tier budget (96): the absolute ceiling is the
  // hard backstop the adaptive budget can never exceed.
  const events = await collect(loopingProvider({ input: 1, window: 1_000_000 }), {
    loop: { emergencyMaxSteps: 3 },
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

test("a provider-rendered tool-markup leak is nudged once toward the typed interface", async () => {
  let nudgePrompt = "";
  let calls = 0;
  const events = await collect(
    textProvider({
      providerId: "deepseek",
      first: '<tool_call>{"name":"read","arguments":{"path":"AGENTS.md"}}</tool_call>',
      second: "Read complete. The entry point is src/main.ts.",
      onMessages: (messages) => {
        calls += 1;
        if (calls === 2) {
          nudgePrompt = messages.map((m) => m.content).join("\n");
        }
      },
    }),
  );

  assert.equal(calls, 2, "the model is re-called once after the leak");
  assert.match(nudgePrompt, /typed tool-calling interface/i, "the nudge is in the re-run prompt");
  // The nudge recovered: a real answer streamed and no anomaly stop fired.
  const text = events
    .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");
  assert.match(text, /entry point is src\/main\.ts/, "the turn continues to a real answer");
  assert.equal(
    events.find((e) => e.type === "stop"),
    undefined,
    "a single leak does not stop",
  );
});

test("a persistent provider tool-markup leak stops as a protocol anomaly with a diagnostic", async () => {
  const leak = '<tool_call>{"name":"read","arguments":{"path":"AGENTS.md"}}</tool_call>';
  const events = await collect(textProvider({ providerId: "deepseek", first: leak, second: leak }));

  const stop = events.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "provider_protocol_anomaly");
  assert.equal(stop?.type === "stop" && stop.stop.action, "paused");
  assert.match(
    stop?.type === "stop" ? stop.stop.summary : "",
    /DeepSeek rendered tool-call JSON or tags/i,
  );
  // The terminal stop carries the typed incident the web/doctor consume.
  assert.equal(stop?.type === "stop" ? stop.diagnostic?.reason : undefined, "protocol_anomaly");
  assert.equal(stop?.type === "stop" ? stop.diagnostic?.phase : undefined, "tool-protocol");
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

test("M3: unknown context (no served window) pauses at the conservative fallback", async () => {
  // window 0 => "missing" telemetry: the budget stays at the 32-step fallback rather than adapting up,
  // and the context gate (which needs a positive window) never fires, so it runs to the backstop.
  const events = await collect(loopingProvider({ input: 100, window: 0 }));
  const limit = events.find((e) => e.type === "step_limit");
  assert.equal(
    limit?.type === "step_limit" && limit.steps,
    32,
    "unknown context stays conservative, not adaptive",
  );
  const stop = events.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "step_backstop");
});

const textOf = (events: readonly AgentEvent[]): string =>
  events
    .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("");

test("03.1 M2: a turn seeded over the fraction synthesizes at step 0 with no tool round", async () => {
  // The prior turn left context at 100% of a 100-token window: seeding the gate lets step 0 see it,
  // so the turn synthesizes immediately instead of opening one mandatory (and doomed) tool round.
  const events = await collect(loopingProvider({ input: 100, window: 100 }), {
    seedUsage: { input: 100, contextWindow: 100 },
  });
  assert.ok(
    !events.some((e) => e.type === "tool_start"),
    "no tool round is opened before the step-0 synthesis",
  );
  const stop = events.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "context_pressure");
  assert.equal(stop?.type === "stop" && stop.stop.action, "synthesized");
  const limit = events.find((e) => e.type === "step_limit");
  assert.equal(limit?.type === "step_limit" && limit.steps, 0, "synthesized at step 0");
  assert.equal(textOf(events), "FINAL ANSWER", "the seeded backstop produces the final answer");
});

test("03.1 M2: a turn seeded under the fraction runs the first tool round exactly as today", async () => {
  // A 0.1% seed is nowhere near the gate, so step 0 opens the first tool round and the turn runs to
  // the adaptive backstop - identical to the no-seed path (regression guard).
  const events = await collect(loopingProvider({ input: 100, window: 100_000 }), {
    seedUsage: { input: 100, contextWindow: 100_000 },
  });
  assert.ok(
    events.some((e) => e.type === "tool_start"),
    "the first tool round still runs",
  );
  const limit = events.find((e) => e.type === "step_limit");
  assert.equal(limit?.type === "step_limit" && limit.steps, 32, "runs to the backstop, as today");
});

test("03.1 M2: a turn with no seed opens a tool round before the gate (first-turn parity)", async () => {
  // No seed (a session's first turn): the trackers default to 0, so the gate is blind at step 0 and
  // the mandatory first round runs before the gate can fire at step 1 - exactly today's behavior.
  const events = await collect(loopingProvider({ input: 100, window: 100 }));
  assert.ok(
    events.some((e) => e.type === "tool_start"),
    "the mandatory first tool round runs",
  );
  const limit = events.find((e) => e.type === "step_limit");
  assert.equal(
    limit?.type === "step_limit" && limit.steps,
    1,
    "the gate fires only after step 0's round, never at step 0",
  );
});

test("03.1 M3: the progress guard measures growth from the seed, not the first measured prompt", async () => {
  // The turn is seeded BELOW its (flat) measured prompt: 50k seed vs a constant 60k measured, both
  // far under the gate on a 1M window. Pre-baselining the guard from the seed means the first real
  // usage event does NOT re-baseline - so the first checkpoint sees +10k of growth (60k - 50k) and
  // auto-continues exactly once, then pauses when the next window is flat (60k - 60k).
  const below = await collect(loopingProvider({ input: 60_000, window: 1_000_000 }), {
    seedUsage: { input: 50_000, contextWindow: 1_000_000 },
  });
  assert.equal(
    below.filter((e) => e.type === "checkpoint").length,
    1,
    "seed-to-measured growth counts as progress: one auto-continue, proving no re-baseline at step 0",
  );

  // Seeded AT its measured prompt (no gap): the guard sees flat context from turn start, so it never
  // auto-continues - it pauses at the budget like any flat turn. This isolates the contract: progress
  // is measured from the SEED, so an equal seed yields zero checkpoints.
  const equal = await collect(loopingProvider({ input: 60_000, window: 1_000_000 }), {
    seedUsage: { input: 60_000, contextWindow: 1_000_000 },
  });
  assert.equal(
    equal.filter((e) => e.type === "checkpoint").length,
    0,
    "an equal seed measures no growth: the flat turn pauses, never auto-continues",
  );
  const stop = equal.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "step_backstop");
  // Two full loop simulations: an explicit timeout keeps this from flaking under heavy parallel suite
  // load, where the unit project's default 5s starves a healthy ~0.8s test on a saturated machine.
}, 20_000);

test("M4: context pressure synthesizes before the adaptive budget is spent", async () => {
  // 85% of a 1M window is past the 80% gate: even with the generous 1M tier budget, context pressure
  // wins on the very next round rather than burning the whole adaptive budget first.
  const events = await collect(loopingProvider({ input: 850_000, window: 1_000_000 }));
  const limit = events.find((e) => e.type === "step_limit");
  assert.equal(
    limit?.type === "step_limit" && limit.steps,
    1,
    "the context gate fires immediately",
  );
  const stop = events.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "context_pressure");
  assert.equal(stop?.type === "stop" && stop.stop.action, "synthesized");
});

test("M4: a repeated-tool stall pauses well before the large-context budget", async () => {
  // A 1M window earns a 96-step budget, but a same-tool loop must still pause at the loop-stall gate.
  const events = await collect(
    loopingProvider({ input: 100, window: 1_000_000, repeatedTool: true }),
  );
  const limit = events.find((e) => e.type === "step_limit");
  assert.equal(
    limit?.type === "step_limit" && limit.steps,
    6,
    "the stall gate pauses at 6 rounds, not at the 96-step budget",
  );
  const stop = events.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "loop_stalled");
});

test("M7: each representative context tier pauses at its adaptive budget", async () => {
  const stepsFor = async (window: number) => {
    const events = await collect(loopingProvider({ input: 100, window }));
    return (events.find((e) => e.type === "step_limit") as { steps: number }).steps;
  };
  assert.equal(await stepsFor(16_000), 24, "small (<32k) context stays conservative");
  assert.equal(await stepsFor(128_000), 48, "128k context lifts the budget");
  assert.equal(await stepsFor(1_000_000), 96, "1M context earns the largest budget");
});

test("M7: a 1M context at 14% pressure does not stop at 32", async () => {
  const events = await collect(loopingProvider({ input: 140_000, window: 1_000_000 }));
  const steps = (events.find((e) => e.type === "step_limit") as { steps: number }).steps;
  assert.notEqual(
    steps,
    32,
    "14% pressure is far from the gate; the 1M budget is not pinned to 32",
  );
  assert.equal(steps, 96, "the full 1M tier budget governs at low pressure");
});

// Per-tool-call stall watchdog (the tool-side analog of the provider-stream idle watchdog): a tool
// that never returns is aborted with an `error:` result so the loop keeps going instead of latching
// "Working" forever, while legitimately-blocking and disabled cases pass straight through.

test("tool stall: a hung tool resolves to an `error:` result, never a thrown turn failure", async () => {
  const result = await Effect.runPromise(
    // Effect.never models a half-open call that produces no result; a tiny ceiling trips the watchdog
    // in real time without a slow test.
    withToolStallTimeout("bash", Effect.never as unknown as Effect.Effect<string>, 20),
  );
  assert.match(result, /^error: tool "bash" produced no result after 0s and was aborted/);
});

test("tool stall: a tool that finishes within the ceiling returns its result untouched", async () => {
  const result = await Effect.runPromise(
    withToolStallTimeout("read", Effect.succeed("the file contents"), 1_000),
  );
  assert.equal(result, "the file contents");
});

test("tool stall: ask_user is exempt (it blocks on the human), passed through unwrapped", () => {
  const inner = Effect.never as unknown as Effect.Effect<string>;
  // Identity, not a wrapped effect: the never-bounded human wait must not be timed out at all.
  assert.equal(withToolStallTimeout("ask_user", inner, 20), inner);
});

test("tool stall: a non-positive ceiling disables the guard (identity)", () => {
  const inner = Effect.succeed("x");
  assert.equal(withToolStallTimeout("bash", inner, 0), inner);
});

/**
 * A provider for the 03.1 M4 synthesis empty-retry tests. `toolStep` decides a tools-offered step:
 * "loop" calls a tool (marches toward the context gate), "blank" stalls with no text and no call
 * (the normal empty path). `synthAnswers` are the successive tools-removed (synthesis) answers - the
 * last repeats - so a blank first answer can be retried into a real one; `onSynth` fires on each
 * synthesis step so a test can count retries and prove the shared empty-retry budget.
 */
function synthProvider(opts: {
  input: number;
  window: number;
  toolStep: "loop" | "blank";
  synthAnswers: string[];
  onSynth?: () => void;
}): Provider {
  let toolCalls = 0;
  let synthCalls = 0;
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
    stream: (_messages, tools) => {
      if (tools.length === 0) {
        const text = opts.synthAnswers[synthCalls] ?? opts.synthAnswers.at(-1) ?? "";
        synthCalls += 1;
        opts.onSynth?.();
        return Stream.fromIterable<ProviderEvent>([
          ...(text ? [{ type: "text" as const, text }] : []),
          { type: "usage", usage: usage(opts.input, opts.window) },
        ]);
      }
      toolCalls += 1;
      if (opts.toolStep === "blank") {
        // No text, no tool call: the normal empty-answer path (spends the shared retry budget).
        return Stream.fromIterable<ProviderEvent>([
          { type: "usage", usage: usage(opts.input, opts.window) },
        ]);
      }
      return Stream.fromIterable<ProviderEvent>([
        {
          type: "tool_call",
          call: {
            id: `c${toolCalls}`,
            name: "noop",
            arguments: JSON.stringify({ round: toolCalls }),
          },
        },
        { type: "usage", usage: usage(opts.input, opts.window) },
      ]);
    },
  };
}

test("03.1 M4: a blank forced synthesis retries once and surfaces the non-blank retry as the answer", async () => {
  let synthCalls = 0;
  const events = await collect(
    synthProvider({
      input: 100,
      window: 100,
      toolStep: "loop",
      synthAnswers: ["", "RECOVERED ANSWER"],
      onSynth: () => {
        synthCalls += 1;
      },
    }),
  );
  assert.equal(synthCalls, 2, "the blank synthesis is retried exactly once");
  assert.equal(textOf(events), "RECOVERED ANSWER", "the non-blank retry is the final answer");
  assert.ok(!events.some((e) => e.type === "empty"), "a recovered answer is not an empty turn");
  assert.equal(
    events.filter((e) => e.type === "step_limit").length,
    1,
    "step_limit is emitted once, not re-emitted on the retry",
  );
  const stop = events.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "context_pressure");
});

test("03.1 M4: a still-blank synthesis retry surfaces empty after one attempt", async () => {
  let synthCalls = 0;
  const events = await collect(
    synthProvider({
      input: 100,
      window: 100,
      toolStep: "loop",
      synthAnswers: ["", ""],
      onSynth: () => {
        synthCalls += 1;
      },
    }),
  );
  assert.equal(synthCalls, 2, "exactly one retry, then it gives up");
  assert.ok(
    events.some((e) => e.type === "empty"),
    "a still-blank synthesis surfaces empty",
  );
  assert.equal(textOf(events), "", "no answer text was produced");
});

test("03.1 M4: the empty-retry budget is shared - a normal-path retry leaves synthesize none", async () => {
  // The model stalls (blank, no tool call) on the tools-offered step, spending the single empty-retry
  // budget on the normal path; the re-entry then crosses the gate and synthesizes - which, finding the
  // budget already spent, must NOT retry again (a turn never double-retries). One synthesis call only.
  let synthCalls = 0;
  const events = await collect(
    synthProvider({
      input: 100,
      window: 100,
      toolStep: "blank",
      synthAnswers: [""],
      onSynth: () => {
        synthCalls += 1;
      },
    }),
  );
  assert.equal(
    synthCalls,
    1,
    "synthesize does not retry once the normal path spent the shared budget",
  );
  assert.ok(
    events.some((e) => e.type === "empty"),
    "the blank synthesis still surfaces empty",
  );
});

/**
 * Plan 07 (tool-call guardrails) loop integration. A small provider calls one tool for the first
 * `rounds` steps, then answers - so a test can drive a repeating tool path. The `runTool` seam
 * injects deterministic, hermetic tool results (success or `error:` failure) so the guardrail's
 * append-guidance behavior is exercised without the real executor or the filesystem.
 */
function repeatedToolProvider(opts: {
  tool: string;
  args: string;
  rounds: number;
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
      if (calls > opts.rounds || tools.length === 0) {
        return Stream.fromIterable<ProviderEvent>([
          { type: "text", text: "DONE" },
          { type: "usage", usage: usage(100, 1_000_000) },
        ]);
      }
      return Stream.fromIterable<ProviderEvent>([
        { type: "tool_call", call: { id: `c${calls}`, name: opts.tool, arguments: opts.args } },
        { type: "usage", usage: usage(100, 1_000_000) },
      ]);
    },
  };
}

const toolEnds = (events: readonly AgentEvent[]): string[] =>
  events
    .filter((e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end")
    .map((e) => e.result);

test("each tool execution emits a trevor.tool span (tool name + ok status, no args/output)", async () => {
  const recorder = recordingTelemetrySink();
  const events = await collect(
    repeatedToolProvider({ tool: "read", args: JSON.stringify({ path: "secret.ts" }), rounds: 2 }),
    {
      telemetry: recorder.sink,
      runTool: () => Effect.succeed("private tool output body"),
    },
  );
  assert.ok(
    events.some((e) => e.type === "text"),
    "the turn still answers",
  );

  const spans = recorder.named(SPAN_NAMES.tool);
  assert.equal(spans.length, 2, "one tool span per executed tool call");
  assert.ok(
    spans.every((s) => s.attributes.tool === "read" && s.status === "ok"),
    "each span carries the tool name and an ok status",
  );
  const serialized = JSON.stringify(spans);
  assert.ok(!serialized.includes("secret.ts"), "tool arguments never enter a span");
  assert.ok(!serialized.includes("private tool output body"), "tool output never enters a span");
});

test("M4: repeated exact failures append concise guidance to the current tool result", async () => {
  // `read` is a registry read-only tool, but the injected runner makes it FAIL identically each round;
  // the guardrail tracks the exact-failure streak and warns at the threshold (3).
  const events = await collect(
    repeatedToolProvider({ tool: "read", args: JSON.stringify({ path: "a.ts" }), rounds: 4 }),
    {
      runTool: () => Effect.succeed("error: read failed - file not found"),
      guardrails: { failureWarnAt: 3 },
    },
  );
  const results = toolEnds(events);
  assert.equal(
    results.length,
    4,
    "all four tool calls executed (guidance never suppresses a call)",
  );
  assert.equal(
    results.slice(0, 2).filter((r) => /Guardrail:/.test(r)).length,
    0,
    "the first two failures stay advisory - no guidance appended",
  );
  assert.match(results[2] ?? "", /Guardrail:.*failed 3 times/i, "the third repeat warns the model");
  assert.match(
    results[2] ?? "",
    /^error: read failed - file not found\n\n/,
    "the raw tool result is preserved; guidance is appended after it",
  );
});

test("M4: repeated read-only same-result warnings are appended without suppressing execution", async () => {
  let toolRuns = 0;
  const events = await collect(
    repeatedToolProvider({ tool: "read", args: JSON.stringify({ path: "a.ts" }), rounds: 4 }),
    {
      runTool: () =>
        Effect.sync(() => {
          toolRuns += 1;
          return "the identical file contents";
        }),
      guardrails: { noProgressWarnAt: 3 },
    },
  );
  assert.equal(
    toolRuns,
    4,
    "the read still executed every round - no cached/skipped output (D-003)",
  );
  const starts = events.filter((e) => e.type === "tool_start").length;
  assert.equal(starts, 4, "every tool call still emits a start");
  const results = toolEnds(events);
  assert.match(
    results[2] ?? "",
    /Guardrail:.*identical result 3 times/i,
    "the no-progress warning is appended once the same result repeats",
  );
  assert.match(
    results[2] ?? "",
    /use the result you already have, or change the query, path, or strategy/i,
    "the guidance is action-oriented: use the result or change strategy, not stop using tools",
  );
  assert.doesNotMatch(
    results[2] ?? "",
    /stop using tools|do not use tools/i,
    "the guidance never tells the model to abandon tools entirely (M4 REFACTOR)",
  );
});

test("M4: a read-only path that keeps making progress is never warned", async () => {
  // The injected runner returns a DIFFERENT result each round, so the read is genuinely progressing;
  // no-progress must never fire even though the args repeat (D-004).
  let round = 0;
  const events = await collect(
    repeatedToolProvider({ tool: "read", args: JSON.stringify({ path: "a.ts" }), rounds: 5 }),
    {
      runTool: () =>
        Effect.sync(() => {
          round += 1;
          return `distinct contents ${round}`;
        }),
      guardrails: { noProgressWarnAt: 3 },
    },
  );
  assert.equal(
    toolEnds(events).filter((r) => /Guardrail:/.test(r)).length,
    0,
    "changing results are progress: no guidance is ever appended",
  );
});

const guardrailEvents = (events: readonly AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: "guardrail" }> => e.type === "guardrail");

test("M5: a warn decision rides out as a redacted guardrail AgentEvent", async () => {
  const events = await collect(
    repeatedToolProvider({ tool: "read", args: JSON.stringify({ path: "a.ts" }), rounds: 4 }),
    {
      runTool: () => Effect.succeed("error: read failed - file not found"),
      guardrails: { failureWarnAt: 3 },
    },
  );
  const flagged = guardrailEvents(events);
  assert.ok(flagged.length >= 1, "at least one guardrail event fired once the streak warned");
  const first = flagged[0];
  assert.equal(first?.call.name, "read");
  assert.equal(first?.decision.action, "warn");
  assert.equal(first?.decision.reason, "repeated_failure");
  assert.equal(first?.decision.count, 3);
  assert.match(first?.decision.argsFingerprint ?? "", /^[0-9a-f]{12}$/);
  assert.match(first?.decision.failureFingerprint ?? "", /^[0-9a-f]{12}$/);
});

test("M5: an allow-only tool path emits no guardrail event", async () => {
  const events = await collect(
    repeatedToolProvider({ tool: "read", args: JSON.stringify({ path: "a.ts" }), rounds: 2 }),
    {
      runTool: () => Effect.succeed("error: read failed - file not found"),
      guardrails: { failureWarnAt: 3 },
    },
  );
  assert.equal(guardrailEvents(events).length, 0, "two failures stay advisory - no event");
});

test("M6: hard stops are off by default - a repeating loop path is never synthetically blocked", async () => {
  const events = await collect(
    repeatedToolProvider({ tool: "read", args: JSON.stringify({ path: "a.ts" }), rounds: 20 }),
    { runTool: () => Effect.succeed("error: read failed - file not found") },
  );
  // Every tool result still carries the real failure output (warn appends, never substitutes).
  assert.ok(
    toolEnds(events).every((r) => /file not found/.test(r)),
    "with hard stops off, the raw failure output is always preserved",
  );
  assert.equal(
    guardrailEvents(events).every((e) => e.decision.action === "warn"),
    true,
    "no block decision ever fires by default",
  );
});

test("M6: an enabled hard stop substitutes a synthetic retryable result and the loop still terminates", async () => {
  const events = await collect(
    repeatedToolProvider({ tool: "read", args: JSON.stringify({ path: "a.ts" }), rounds: 20 }),
    {
      runTool: () => Effect.succeed("error: read failed - file not found"),
      guardrails: { failureWarnAt: 3, hardStop: true, hardStopAt: 5 },
    },
  );
  const results = toolEnds(events);
  // The 5th identical failure (hardStopAt) is blocked: its raw output is WITHHELD and replaced by the
  // synthetic retryable guidance (execution still happened - D-003).
  const blocked = results[4] ?? "";
  assert.match(
    blocked,
    /Guardrail:.*withheld/i,
    "the synthetic block result replaces the raw output",
  );
  assert.doesNotMatch(
    blocked,
    /file not found/,
    "the repeated raw output is withheld from the model",
  );
  // Composition with the existing turn-termination policy: the same repeating signature still trips
  // the loop-stall gate, so the guarded loop reaches a typed terminal reason rather than spinning.
  const stop = events.find((e) => e.type === "stop");
  assert.equal(stop?.type === "stop" && stop.stop.cause, "loop_stalled");
  assert.equal(stop?.type === "stop" && stop.stop.action, "paused");
  // A redacted block event also rode out for the UI.
  assert.ok(
    guardrailEvents(events).some((e) => e.decision.action === "block"),
    "a block guardrail event was emitted",
  );
});
