import assert from "node:assert/strict";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai/compat";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import type { CredentialResolver } from "./credentials";
import { ProviderAuthError } from "./errors";
import { PiAiProviderBase, type PiAiProviderParams } from "./pi-ai-base";

/**
 * Characterization tests for the shared pi-ai provider base (M2 / D-005).
 *
 * The base owns the stream/readiness/capabilities template that codex.ts and pi-key.ts used to
 * duplicate; only the credential strategy and the model lookup are injected. These pin that the
 * injected pieces drive the observable behavior: readiness reflects whether a credential resolves,
 * capabilities reflect the resolved (or fallback) model, the default reasoning is derived from the
 * advertised levels, and a credential failure rides the stream's typed ProviderAuthError channel.
 */

/** A stub credential resolver: resolves a fixed key, or rejects with the given error. */
function stubCredentials(result: { key: string } | { error: unknown }): CredentialResolver {
  return {
    resolveApiKey: () =>
      "key" in result ? Promise.resolve(result.key) : Promise.reject(result.error),
  };
}

/** A minimal fake pi-ai model carrying just the fields the base reads. */
function fakeModel(fields: {
  reasoning?: unknown;
  input?: readonly string[];
  contextWindow?: number;
}): Model<Api> {
  return {
    id: "fake",
    reasoning: fields.reasoning ?? true,
    input: fields.input ?? ["text"],
    contextWindow: fields.contextWindow ?? 128000,
  } as unknown as Model<Api>;
}

function makeBase(overrides: Partial<PiAiProviderParams> = {}): PiAiProviderBase {
  return new PiAiProviderBase({
    id: "stub",
    label: "Stub",
    model: "stub-model",
    credentials: stubCredentials({ key: "sk-test" }),
    resolveModel: () => fakeModel({}),
    fallback: { levels: ["off", "high"], images: false },
    pickDefaultReasoning: (levels) => (levels.includes("high") ? "high" : "off"),
    ...overrides,
  });
}

test("capabilities reflect the resolved model: image support from input, tools always, context 0", () => {
  const vision = makeBase({ resolveModel: () => fakeModel({ input: ["text", "image"] }) });
  const caps = Effect.runSync(vision.capabilities());
  assert.deepEqual(caps, { images: true, tools: true, contextLength: 0 });

  const textOnly = makeBase({ resolveModel: () => fakeModel({ input: ["text"] }) });
  assert.equal(Effect.runSync(textOnly.capabilities()).images, false);
});

test("reasoning levels + default are derived from the resolved model", () => {
  const model = fakeModel({ reasoning: ["off", "low", "medium", "high"] });
  const expectedLevels = getSupportedThinkingLevels(model);
  const base = makeBase({
    resolveModel: () => model,
    pickDefaultReasoning: (levels) => (levels.includes("medium") ? "medium" : "off"),
  });
  assert.deepEqual(base.reasoningLevels, expectedLevels);
  assert.equal(base.defaultReasoning, expectedLevels.includes("medium") ? "medium" : "off");
});

test("a model not in the registry falls back to the declared shape (host still starts)", () => {
  const base = makeBase({
    resolveModel: () => {
      throw new Error("model not in registry");
    },
    fallback: { levels: ["off", "high"], images: false },
    pickDefaultReasoning: (levels) => (levels.includes("high") ? "high" : "off"),
  });
  assert.deepEqual(base.reasoningLevels, ["off", "high"]);
  assert.equal(base.defaultReasoning, "high");
  assert.equal(Effect.runSync(base.capabilities()).images, false);
});

test("readiness is ready+warm when a credential resolves, not-ready+warm when it does not", async () => {
  const ok = makeBase({ credentials: stubCredentials({ key: "sk-test" }) });
  assert.deepEqual(await Effect.runPromise(ok.readiness()), { ready: true, warm: true });

  const missing = makeBase({
    credentials: stubCredentials({
      error: new ProviderAuthError({ provider: "stub", detail: "x" }),
    }),
  });
  assert.deepEqual(await Effect.runPromise(missing.readiness()), { ready: false, warm: true });
});

test("cloud providers are always warm and warm() is a no-op", () => {
  const base = makeBase();
  assert.equal(base.kind, "cloud");
  assert.equal(Effect.runSync(base.warm()), undefined);
});

test("a credential failure rides the stream's typed ProviderAuthError channel", async () => {
  const authError = new ProviderAuthError({ provider: "stub", detail: "no key" });
  const base = makeBase({ credentials: stubCredentials({ error: authError }) });
  const exit = await Effect.runPromiseExit(Stream.runDrain(base.stream([], [])));
  assert.equal(exit._tag, "Failure");
  if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
    assert.ok(exit.cause.error instanceof ProviderAuthError);
    assert.equal(exit.cause.error.provider, "stub");
  } else {
    assert.fail("expected a ProviderAuthError failure");
  }
});

test("a non-auth credential failure is wrapped as ProviderAuthError on the stream", async () => {
  const base = makeBase({ credentials: stubCredentials({ error: new Error("disk gone") }) });
  const exit = await Effect.runPromiseExit(Stream.runDrain(base.stream([], [])));
  assert.equal(exit._tag, "Failure");
  if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
    assert.ok(exit.cause.error instanceof ProviderAuthError);
    assert.match(exit.cause.error.detail, /disk gone/);
  } else {
    assert.fail("expected a wrapped ProviderAuthError failure");
  }
});
