import assert from "node:assert/strict";
import { events, PRODUCER_IDS } from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import { createModelSourceResolver, type ProviderRegistry } from "./model-source-resolver";
import { createTurnProviderResolver } from "./turn-provider-resolver";
import { DescribableProvider } from "./types";

class FakeProvider extends DescribableProvider {
  readonly reasoningLevels = [];
  readonly defaultReasoning = "off";
  readonly kind = "cloud" as const;

  constructor(
    readonly id: string,
    readonly label: string,
    readonly model: string,
  ) {
    super();
  }

  readiness() {
    return Effect.succeed({ ready: true, warm: true });
  }

  capabilities() {
    return Effect.succeed({ images: false, tools: true, contextLength: 1000 });
  }

  warm() {
    return Effect.void;
  }

  stream() {
    return Stream.empty;
  }
}

function providers(): ProviderRegistry {
  return {
    qwen: new FakeProvider("qwen", "Qwen", "qwen-model"),
    glm: new FakeProvider("glm", "GLM", "glm-legacy"),
  };
}

test("turn provider resolver preserves ModelRef reasoning and catalog source selection", () => {
  const resolver = createTurnProviderResolver({
    providers: providers(),
    defaultProviderKey: "qwen",
  });

  const event = storedEvent(
    events.userMessage({
      text: "run",
      provider: "qwen",
      reasoning: "off",
      model: { sourceId: "zai", modelId: "glm-5.2", reasoning: "xhigh" },
    }),
    { producerId: PRODUCER_IDS.web },
  );

  const resolved = resolver.resolveUserMessage(event);
  assert.equal(resolved?.source, "catalog");
  assert.equal(resolved?.provider.id, "zai");
  assert.equal(resolved?.provider.model, "glm-5.2");
  assert.deepEqual(resolved?.model, { sourceId: "zai", reasoning: "xhigh" });
});

test("turn provider resolver falls back through legacy provider ids and default provider", () => {
  const resolver = createTurnProviderResolver({
    providers: providers(),
    defaultProviderKey: "qwen",
  });

  assert.equal(resolver.resolveTurnProvider({ provider: "glm" }).provider.id, "glm");
  assert.equal(resolver.resolveTurnProvider({ provider: "missing" }).provider.id, "qwen");
  assert.equal(resolver.resolveUserMessage(storedEvent(events.userCancel({ runId: "r1" }))), null);
});

test("start and preflight can resolve through the same provider boundary", () => {
  const registry = providers();
  const startResolver = createModelSourceResolver({
    providers: registry,
    defaultProviderKey: "qwen",
  });
  const preflightResolver = createTurnProviderResolver({
    providers: registry,
    defaultProviderKey: "qwen",
  });
  const input = {
    provider: "zai",
    reasoning: "low",
    model: { sourceId: "zai", modelId: "glm-5.2", reasoning: "xhigh" },
  } as const;

  assert.equal(
    preflightResolver.resolveTurnProvider(input).provider.model,
    startResolver.resolveTurnProvider(input).provider.model,
  );
});
