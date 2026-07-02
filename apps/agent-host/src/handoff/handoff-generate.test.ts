import assert from "node:assert/strict";
import type { ChatMessage, Provider, ProviderEvent } from "@host/providers/index";
import { ProviderUnavailable } from "@host/providers/index";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import {
  buildHandoffGenerationPrompt,
  generateHandoffPrompt,
  HANDOFF_CONTEXT_TURN_LIMIT,
  hasGenerableContext,
} from "./handoff-generate";

/**
 * Generated-handoff prompt generation (02.10, M5/M6). The builder tests are pure (no provider); the
 * generation tests drive `generateHandoffPrompt` with a fake provider - mirroring summarize.test - to
 * assert the call is tool-less, the draft is the streamed text capped to the budget, and a provider
 * failure rides the typed error channel (so the host can fail the handoff and keep the source active).
 */

function fakeProvider(opts: {
  text?: string;
  fail?: boolean;
  reasoningLevels?: readonly string[];
  capture?: (
    messages: readonly ChatMessage[],
    tools: number,
    reasoning: string | undefined,
  ) => void;
}): Provider {
  const reasoningLevels = opts.reasoningLevels ?? ["off", "high"];
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
      opts.capture?.(messages, tools.length, reasoning);
      if (opts.fail) {
        return Stream.fail(
          new ProviderUnavailable({ provider: "fake", detail: "model down", retryable: true }),
        );
      }
      return Stream.fromIterable<ProviderEvent>([{ type: "text", text: opts.text ?? "" }]);
    },
  };
}

const turn = (role: "user" | "assistant", content: string): ChatMessage => ({ role, content });

test("hasGenerableContext is false for empty or whitespace-only history", () => {
  assert.equal(hasGenerableContext([]), false);
  assert.equal(hasGenerableContext([turn("user", "   "), turn("assistant", "")]), false);
  assert.equal(hasGenerableContext([turn("user", "do the thing")]), true);
});

test("the generation prompt is one tool-less user message naming the workspace", () => {
  const messages = buildHandoffGenerationPrompt({
    history: [turn("user", "build the parser"), turn("assistant", "done the lexer")],
    cwd: "/work/repo",
    workspace: "/work",
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "user");
  const text = messages[0]?.content ?? "";
  assert.match(text, /cwd: \/work\/repo/);
  assert.match(text, /workspace: \/work/);
  assert.match(text, /build the parser/);
  assert.match(text, /done the lexer/);
  assert.match(text, /ONLY the prompt/i);
});

test("an explicit /handoff request is woven in as emphasis", () => {
  const text =
    buildHandoffGenerationPrompt({
      history: [turn("user", "x")],
      cwd: "/w",
      workspace: "/w",
      request: "focus on the migration",
    })[0]?.content ?? "";
  assert.match(text, /emphasize/i);
  assert.match(text, /focus on the migration/);
});

test("only the most recent turns feed the prompt (bounded context)", () => {
  const history = Array.from({ length: HANDOFF_CONTEXT_TURN_LIMIT + 6 }, (_, i) =>
    turn(i % 2 === 0 ? "user" : "assistant", `turn-${i}`),
  );
  const text =
    buildHandoffGenerationPrompt({ history, cwd: "/w", workspace: "/w" })[0]?.content ?? "";
  // The oldest turns are dropped; the newest are kept.
  assert.doesNotMatch(text, /turn-0\b/);
  assert.match(text, new RegExp(`turn-${history.length - 1}\\b`));
});

test("generateHandoffPrompt returns the streamed draft, tool-less and cheapest-reasoning", async () => {
  let toolsSeen = -1;
  let reasoningSeen: string | undefined = "unset";
  const provider = fakeProvider({
    text: "  Continue building the parser: next implement the emitter.  ",
    capture: (_messages, tools, reasoning) => {
      toolsSeen = tools;
      reasoningSeen = reasoning;
    },
  });
  const draft = await Effect.runPromise(
    generateHandoffPrompt(provider, { history: [turn("user", "x")], cwd: "/w", workspace: "/w" }),
  );
  assert.equal(draft, "Continue building the parser: next implement the emitter.");
  assert.equal(toolsSeen, 0, "generation is tool-less");
  assert.equal(reasoningSeen, "off", "reasoning forced to the cheapest level");
});

test("generateHandoffPrompt caps an overlong draft to the char backstop", async () => {
  const draft = await Effect.runPromise(
    generateHandoffPrompt(fakeProvider({ text: "y".repeat(20_000) }), {
      history: [turn("user", "x")],
      cwd: "/w",
      workspace: "/w",
    }),
  );
  assert.equal(draft.length, 600 * 4, "capped to ~600 tokens (~2.4k chars)");
});

test("a provider failure rides the typed error channel", async () => {
  const exit = await Effect.runPromiseExit(
    generateHandoffPrompt(fakeProvider({ fail: true }), {
      history: [turn("user", "x")],
      cwd: "/w",
      workspace: "/w",
    }),
  );
  assert.equal(exit._tag, "Failure");
});
