import assert from "node:assert/strict";
import { Effect, Stream } from "effect";
import { test } from "vitest";
import {
  createModelSourceResolver,
  type ProviderRegistry,
  pickProviderFromRegistry,
} from "./model-source-resolver";
import { DescribableProvider } from "./types";

/**
 * Responsible for: turn-time provider resolution across structured ModelRefs and legacy provider keys.
 * Not for: catalog snapshot projection, covered by catalog.test.ts.
 */

class FakeProvider extends DescribableProvider {
  readonly reasoningLevels = [];
  readonly defaultReasoning = "off";
  readonly kind: "local" | "cloud";

  constructor(
    readonly id: string,
    readonly label: string,
    readonly model: string,
    kind: "local" | "cloud" = "cloud",
  ) {
    super();
    this.kind = kind;
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
    qwen: new FakeProvider("qwen", "Qwen", "qwen-model", "local"),
    glm: new FakeProvider("glm", "GLM", "glm-legacy"),
  };
}

test("legacy provider keys resolve through the defaulted registry path", () => {
  const resolver = createModelSourceResolver({
    providers: providers(),
    defaultProviderKey: "qwen",
  });

  assert.equal(resolver.pickProvider("glm").id, "glm");
  assert.equal(resolver.pickProvider("missing").id, "qwen");
  assert.equal(resolver.pickProvider(undefined).id, "qwen");
  assert.equal(pickProviderFromRegistry(providers(), "glm", "qwen").id, "glm");
});

test("a structured ModelRef resolves through the catalog source builder before legacy fallback", () => {
  const resolver = createModelSourceResolver({
    providers: providers(),
    defaultProviderKey: "qwen",
  });

  const catalog = resolver.resolveTurnProvider({
    model: { sourceId: "zai", modelId: "glm-5.2", reasoning: "xhigh" },
    provider: "qwen",
    reasoning: "off",
  });
  assert.equal(catalog.source, "catalog");
  assert.equal(catalog.provider.id, "zai");
  assert.equal(catalog.provider.model, "glm-5.2");
  assert.deepEqual(catalog.model, { sourceId: "zai", reasoning: "xhigh" });

  const legacy = resolver.resolveTurnProvider({ provider: "glm", reasoning: "high" });
  assert.equal(legacy.source, "legacy");
  assert.equal(legacy.provider.id, "glm");
  assert.deepEqual(legacy.model, { sourceId: "glm", reasoning: "high" });
});

test("an unknown structured source falls through to the default provider", () => {
  const resolver = createModelSourceResolver({
    providers: providers(),
    defaultProviderKey: "qwen",
  });

  const missing = resolver.resolveTurnProvider({
    model: { sourceId: "not-a-source", modelId: "whatever", reasoning: null },
  });
  assert.equal(missing.source, "default");
  assert.equal(missing.provider.id, "qwen");

  const absent = resolver.resolveTurnProvider({});
  assert.equal(absent.source, "default");
  assert.equal(absent.provider.id, "qwen");
});
