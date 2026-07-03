import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Chunk, Effect, Stream } from "effect";
import { test } from "vitest";
import {
  buildChildEnv,
  claudeCodeProvider,
  resolveClaudeCodeToken,
  type SdkQuery,
  streamClaudeCode,
} from "./claude-code";
import { ProviderAuthError, ProviderUnavailable } from "./errors";
import { recordLearnedWindow } from "./model-metadata-overrides";
import type { ProviderEvent } from "./types";

/**
 * Unit tests for the Claude Code (Max plan) provider (plan 12.1). The Agent SDK `query` is injected
 * as a seam, so the naked-per-turn spawn options, the SDK-event -> ProviderEvent mapping, the
 * subprocess env hygiene (D-002), and the fail-closed missing-token behavior are all pinned without
 * spawning a real subprocess.
 */

/** A fake `query` that yields a scripted message sequence and records the params it was called with. */
function recordingQuery(script: readonly SDKMessage[]): {
  readonly query: SdkQuery;
  readonly calls: Array<{ prompt: unknown; options: unknown }>;
} {
  const calls: Array<{ prompt: unknown; options: unknown }> = [];
  const query: SdkQuery = (params) => {
    calls.push({ prompt: params.prompt, options: params.options });
    return (async function* () {
      for (const message of script) {
        yield message;
      }
    })();
  };
  return { query, calls };
}

/** A fake `query` whose iteration rejects on the first step - a terminal SDK/subprocess failure. */
const throwingQuery: SdkQuery = () => ({
  [Symbol.asyncIterator]: () => ({
    next: (): Promise<IteratorResult<SDKMessage>> =>
      Promise.reject(new Error("subprocess exploded")),
  }),
});

const textDelta = (text: string): SDKMessage =>
  ({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage;

const thinkingDelta = (thinking: string): SDKMessage =>
  ({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage;

const resultSuccess = (input: number, output: number): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    usage: { input_tokens: input, output_tokens: output },
    result: "",
  }) as unknown as SDKMessage;

const resultError = (): SDKMessage =>
  ({
    type: "result",
    subtype: "error_during_execution",
    errors: ["model overloaded"],
  }) as unknown as SDKMessage;

async function collect(stream: Stream.Stream<ProviderEvent, unknown>): Promise<ProviderEvent[]> {
  return Chunk.toReadonlyArray(
    await Effect.runPromise(Stream.runCollect(stream)),
  ) as ProviderEvent[];
}

test("stream runs ONE naked query with the plan's exact options and the passed system prompt", async () => {
  const { query, calls } = recordingQuery([resultSuccess(10, 5)]);
  await collect(
    streamClaudeCode({
      query,
      systemPrompt: "SYSTEM-PROMPT-XYZ",
      messages: [{ role: "user", content: "hi" }],
      token: "max-token",
      parentEnv: {},
    }),
  );
  assert.equal(calls.length, 1, "exactly one query() per stream (one model step)");
  const options = calls[0]?.options as Record<string, unknown>;
  assert.equal(
    options.systemPrompt,
    "SYSTEM-PROMPT-XYZ",
    "the passed prompt fully replaces the default",
  );
  assert.deepEqual(options.tools, [], "all built-in tools stripped at the availability layer");
  assert.deepEqual(options.settingSources, [], "filesystem settings ignored");
  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.includePartialMessages, true, "token streaming enabled");
});

test("the provider ignores the host-passed tools arg (the SDK always gets tools:[])", async () => {
  const { query, calls } = recordingQuery([resultSuccess(1, 1)]);
  const provider = claudeCodeProvider({
    model: "claude-opus-4-0",
    label: "Claude (Max plan)",
    query,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "max-token" },
  });
  await collect(
    provider.stream(
      [{ role: "user", content: "hello" }],
      [{ name: "bash", description: "run a shell command", parameters: {} }],
    ),
  );
  assert.equal(calls.length, 1);
  const options = calls[0]?.options as Record<string, unknown>;
  assert.deepEqual(options.tools, [], "the host tool never reaches the SDK");
  assert.equal(typeof options.systemPrompt, "string");
  assert.ok((options.systemPrompt as string).length > 0, "a real system prompt is built");
});

test("maps text_delta -> text, thinking_delta -> thinking, and the success result -> usage", async () => {
  const { query } = recordingQuery([
    thinkingDelta("let me think"),
    textDelta("Hello"),
    textDelta(", world"),
    resultSuccess(120, 42),
  ]);
  const events = await collect(
    streamClaudeCode({
      query,
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      token: "max-token",
      contextWindow: 200_000,
    }),
  );
  assert.deepEqual(
    events.filter((e) => e.type === "thinking"),
    [{ type: "thinking", text: "let me think" }],
  );
  assert.deepEqual(
    events.filter((e) => e.type === "text"),
    [
      { type: "text", text: "Hello" },
      { type: "text", text: ", world" },
    ],
    "text deltas stream through in order",
  );
  const usage = events.find((e) => e.type === "usage");
  assert.ok(usage && usage.type === "usage");
  assert.equal(usage.usage.input, 120);
  assert.equal(usage.usage.output, 42);
  assert.equal(usage.usage.contextWindow, 200_000);
});

test("a terminal SDK error subtype rides the typed ProviderError channel, classified for retry", async () => {
  const { query } = recordingQuery([textDelta("partial"), resultError()]);
  const exit = await Effect.runPromiseExit(
    Stream.runDrain(
      streamClaudeCode({
        query,
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        token: "max-token",
      }),
    ),
  );
  assert.equal(exit._tag, "Failure");
  if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
    const error = exit.cause.error;
    assert.ok(error instanceof ProviderUnavailable, "error subtype -> ProviderUnavailable");
    // The shared boundary normalizer classifies the failure: an overloaded Max pool is a
    // retryable provider_overloaded, so the loop's auto-reconnect applies to this source too.
    assert.equal(error.classification, "provider_overloaded", "the taxonomy class is carried");
    assert.equal(error.retryable, true, "an overload is retryable (auto-reconnect eligible)");
  } else {
    assert.fail("expected a ProviderUnavailable failure");
  }
});

test("a thrown iterator failure rides the typed ProviderError channel", async () => {
  const exit = await Effect.runPromiseExit(
    Stream.runDrain(
      streamClaudeCode({
        query: throwingQuery,
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        token: "max-token",
      }),
    ),
  );
  assert.equal(exit._tag, "Failure");
  if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
    assert.ok(exit.cause.error instanceof ProviderUnavailable);
  } else {
    assert.fail("expected a ProviderUnavailable failure");
  }
});

test("capabilities reports tools:false (vision per model), readiness is warm, describe carries the roster", () => {
  const provider = claudeCodeProvider({
    model: "claude-opus-4-0",
    label: "Claude (Max plan)",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "max-token" },
  });
  const caps = Effect.runSync(provider.capabilities());
  assert.equal(caps.tools, false, "tools are never exposed to the SDK (D-004)");
  assert.equal(
    caps.images,
    true,
    "claude-opus-4-0 is vision-capable (registry input, or fallback)",
  );

  const readiness = Effect.runSync(provider.readiness());
  assert.equal(readiness.warm, true, "cloud is always warm");
  assert.equal(readiness.ready, true, "ready when the CLI token is present");

  const model = provider.describe();
  assert.equal(model.label, "Claude (Max plan)");
  assert.equal(model.model, "claude-opus-4-0");
  assert.equal(model.kind, "cloud");
  // Claude thinking is disableable and reaches "high" on both the registry shape
  // (off/minimal/low/medium/high) and the registry-miss fallback (off/high).
  assert.ok(model.reasoningLevels.includes("off"), "thinking is disableable");
  assert.ok(model.reasoningLevels.includes("high"), "a high thinking level is advertised");
  assert.ok(
    model.reasoningLevels.includes(model.defaultReasoning),
    "the default reasoning is one of the advertised levels",
  );
});

test("the provider's context window routes through resolveContextWindow (corrections honored)", async () => {
  // A model id unknown to the registry, with a corrected window recorded through the resolver's
  // learned lever - the same resolveContextWindow precedence a user's models.json override rides
  // (override > learned > bundled). The provider must consult the resolver, not the bundled value
  // alone, so the usage row budgets against the corrected ceiling instead of the 200k default.
  const modelId = "claude-test/corrected-window-probe";
  recordLearnedWindow(modelId, 55_000);

  const { query } = recordingQuery([resultSuccess(10, 5)]);
  const provider = claudeCodeProvider({
    model: modelId,
    label: "Claude (Max plan)",
    query,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "max-token" },
  });
  const events = await collect(provider.stream([{ role: "user", content: "hi" }], []));
  const usage = events.find((e) => e.type === "usage");
  assert.ok(usage && usage.type === "usage");
  assert.equal(usage.usage.contextWindow, 55_000, "the corrected window wins over the default");
});

test("readiness is not-ready (but warm) when the CLI token is absent", () => {
  const provider = claudeCodeProvider({
    model: "claude-opus-4-0",
    label: "Claude (Max plan)",
    env: {},
  });
  const readiness = Effect.runSync(provider.readiness());
  assert.deepEqual(readiness, { ready: false, warm: true });
});

// --- M2: subprocess env hygiene (D-002) ---

test("buildChildEnv deletes ANTHROPIC_API_KEY entirely and injects the Max OAuth token", () => {
  const env = buildChildEnv(
    { ANTHROPIC_API_KEY: "sk-stale-api-key", PATH: "/usr/bin", HOME: "/home/x" },
    "max-oauth-token",
  );
  assert.ok(!("ANTHROPIC_API_KEY" in env), "the stale API key is REMOVED, not set to empty");
  assert.equal(
    env.CLAUDE_CODE_OAUTH_TOKEN,
    "max-oauth-token",
    "the Max token bills the subscription",
  );
  assert.equal(env.PATH, "/usr/bin", "inherited vars like PATH survive");
  assert.equal(env.HOME, "/home/x");
});

test("the env handed to query() carries the token and NO ANTHROPIC_API_KEY, even with a stale parent key", async () => {
  const { query, calls } = recordingQuery([resultSuccess(1, 1)]);
  await collect(
    streamClaudeCode({
      query,
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      token: "max-token",
      parentEnv: { ANTHROPIC_API_KEY: "sk-stale", PATH: "/bin" },
    }),
  );
  const options = calls[0]?.options as { env: Record<string, string | undefined> };
  assert.ok(!("ANTHROPIC_API_KEY" in options.env), "no ANTHROPIC_API_KEY key reaches the child");
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, "max-token");
  assert.equal(options.env.PATH, "/bin");
});

test("a missing CLI token fails closed with a typed ProviderAuthError - the query never runs", async () => {
  const { query, calls } = recordingQuery([resultSuccess(1, 1)]);
  const exit = await Effect.runPromiseExit(
    Stream.runDrain(
      streamClaudeCode({
        query,
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        token: null,
      }),
    ),
  );
  assert.equal(
    calls.length,
    0,
    "no subprocess is spawned without a token (no API-credit fallthrough)",
  );
  assert.equal(exit._tag, "Failure");
  if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
    assert.ok(exit.cause.error instanceof ProviderAuthError);
  } else {
    assert.fail("expected a ProviderAuthError failure");
  }
});

test("resolveClaudeCodeToken reads the CLI token env, treating empty as absent", () => {
  assert.equal(resolveClaudeCodeToken({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }), "tok");
  assert.equal(resolveClaudeCodeToken({ CLAUDE_CODE_OAUTH_TOKEN: "" }), null);
  assert.equal(resolveClaudeCodeToken({}), null);
});
