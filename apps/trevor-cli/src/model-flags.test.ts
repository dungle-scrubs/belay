import assert from "node:assert/strict";
import type { CatalogSnapshot } from "@trevor/sdk";
import type { CatalogEntry, SourceSummary } from "@trevor/session";
import { test } from "vitest";
import { formatCatalog, ModelFlagError, resolveModelRef } from "./model-flags";

function source(sourceId: string, modelCount: number): SourceSummary {
  return {
    sourceId,
    type: "api-key",
    label: sourceId,
    status: "ready",
    modelCount,
    auth: "authenticated",
    freshness: { refreshedAt: null, stale: false },
    actions: [],
  };
}

function entry(sourceId: string, modelId: string): CatalogEntry {
  return {
    sourceId,
    modelId,
    displayName: modelId,
    kind: "cloud",
    capabilities: ["reasoning"],
    contextLength: null,
    costTier: null,
    aliases: [],
    freshness: { refreshedAt: null, stale: false },
    reasoningLevels: ["off", "low", "high"],
    defaultReasoning: "low",
  };
}

function catalog(entries: readonly CatalogEntry[]): CatalogSnapshot {
  const catalogBySource: Record<string, CatalogEntry[]> = {};
  for (const item of entries) {
    catalogBySource[item.sourceId] = [...(catalogBySource[item.sourceId] ?? []), item];
  }
  return {
    sources: [source("openai", 2), source("anthropic", 1)],
    catalogBySource,
  };
}

test("resolveModelRef accepts qualified and unambiguous bare model ids", () => {
  const snapshot = catalog([entry("openai", "gpt-5"), entry("anthropic", "claude")]);

  assert.deepEqual(resolveModelRef(snapshot, { model: "openai/gpt-5", reasoning: "high" }), {
    sourceId: "openai",
    modelId: "gpt-5",
    reasoning: "high",
  });
  assert.deepEqual(resolveModelRef(snapshot, { model: "claude" }), {
    sourceId: "anthropic",
    modelId: "claude",
    reasoning: null,
  });
});

test("resolveModelRef fails fast on ambiguous, unknown, or unsupported values", () => {
  const snapshot = catalog([entry("openai", "chat"), entry("anthropic", "chat")]);

  assert.throws(() => resolveModelRef(snapshot, { model: "chat" }), ModelFlagError);
  assert.throws(() => resolveModelRef(snapshot, { model: "missing" }), /trevor models/);
  assert.throws(
    () => resolveModelRef(snapshot, { model: "openai/chat", reasoning: "xhigh" }),
    /does not support reasoning/,
  );
  assert.throws(() => resolveModelRef(snapshot, { reasoning: "high" }), /requires a model/);
});

test("formatCatalog uses the shared catalog page cap for large catalogs", () => {
  const entries = Array.from({ length: 250 }, (_, index) => entry("openai", `m${index}`));
  const output = formatCatalog(catalog(entries), false);

  assert.match(output, /200 of 250 models shown/);
});
