import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type CatalogEntry,
  catalogEntryFromProviderModel,
  decodeCatalogEntry,
  decodeSourceSummary,
  decodeSourceType,
  modelRefFromProvider,
  projectSourceState,
  providerStringOf,
  type SourceSummary,
} from "./model-source";
import type { ProviderModel } from "./protocol";

/**
 * D-065 M1: the model-source + catalog domain contract. Pins source-type decoding, source-summary +
 * catalog-entry decoding (tolerant of partial/garbled wire JSON), source-state projection, and the
 * backward-compat bridge from the legacy `provider` string + ProviderModel.
 */

test("decodeSourceType accepts the known families and falls back for anything else", () => {
  for (const t of ["local", "oauth", "gateway", "api-key"] as const) {
    assert.equal(decodeSourceType(t), t);
  }
  assert.equal(decodeSourceType("nonsense"), "api-key", "unknown -> safe direct-key default");
  assert.equal(decodeSourceType(undefined), "api-key");
});

test("decodeSourceSummary fills every field and tolerates a partial/garbled row", () => {
  const full = decodeSourceSummary({
    sourceId: "lmstudio",
    type: "local",
    label: "LM Studio",
    status: "ready",
    modelCount: 3,
    auth: "none",
    freshness: { refreshedAt: "2026-06-27T00:00:00.000Z", stale: false },
    actions: ["refresh", "configure", "bogus"],
  });
  assert.deepEqual(full, {
    sourceId: "lmstudio",
    type: "local",
    label: "LM Studio",
    status: "ready",
    modelCount: 3,
    auth: "none",
    freshness: { refreshedAt: "2026-06-27T00:00:00.000Z", stale: false },
    actions: ["refresh", "configure"],
  } satisfies SourceSummary);

  // A near-empty row decodes to safe defaults rather than throwing; label falls back to the id.
  const sparse = decodeSourceSummary({ sourceId: "x" });
  assert.equal(sparse.label, "x");
  assert.equal(sparse.type, "api-key");
  assert.equal(sparse.status, "unavailable");
  assert.equal(sparse.modelCount, 0);
  assert.equal(sparse.auth, "none");
  assert.deepEqual(sparse.actions, []);
  assert.deepEqual(sparse.freshness, { refreshedAt: null, stale: true });

  // A bad status / negative count are coerced, not trusted.
  const coerced = decodeSourceSummary({ sourceId: "y", status: "weird", modelCount: -4 });
  assert.equal(coerced.status, "unavailable");
  assert.equal(coerced.modelCount, 0);
});

test("decodeCatalogEntry defaults unknown context length and cost tier to null", () => {
  const entry = decodeCatalogEntry({
    sourceId: "openai",
    modelId: "gpt-x",
    displayName: "GPT-X",
    kind: "cloud",
    capabilities: ["reasoning", "vision"],
    contextLength: 200000,
    costTier: "high",
    aliases: ["gpt-x-latest"],
    freshness: { refreshedAt: "2026-06-27T00:00:00.000Z", stale: true },
  });
  assert.deepEqual(entry, {
    sourceId: "openai",
    modelId: "gpt-x",
    displayName: "GPT-X",
    kind: "cloud",
    capabilities: ["reasoning", "vision"],
    contextLength: 200000,
    costTier: "high",
    aliases: ["gpt-x-latest"],
    freshness: { refreshedAt: "2026-06-27T00:00:00.000Z", stale: true },
  } satisfies CatalogEntry);

  const sparse = decodeCatalogEntry({ modelId: "m" });
  assert.equal(sparse.displayName, "m", "display name falls back to the model id");
  assert.equal(sparse.kind, "cloud");
  assert.equal(sparse.contextLength, null, "unknown context length -> null, not 0");
  assert.equal(sparse.costTier, null, "unknown/garbled cost tier -> null");
  assert.deepEqual(sparse.capabilities, []);

  // A non-positive or garbled context length is rejected to null.
  assert.equal(decodeCatalogEntry({ modelId: "m", contextLength: 0 }).contextLength, null);
  assert.equal(decodeCatalogEntry({ modelId: "m", contextLength: "lots" }).contextLength, null);
  assert.equal(decodeCatalogEntry({ modelId: "m", costTier: "cheap" }).costTier, null);
});

const summary = (over: Partial<SourceSummary>): SourceSummary => ({
  sourceId: "s",
  type: "oauth",
  label: "S",
  status: "ready",
  modelCount: 2,
  auth: "authenticated",
  freshness: { refreshedAt: "2026-06-27T00:00:00.000Z", stale: false },
  actions: [],
  ...over,
});

test("projectSourceState makes a ready, authenticated, model-bearing source selectable", () => {
  const state = projectSourceState(summary({}));
  assert.equal(state.selectable, true);
  assert.equal(state.needsAttention, false);
  assert.equal(state.summary, "2 models");
});

test("projectSourceState flags auth and error states as needing attention, not selectable", () => {
  const expired = projectSourceState(summary({ auth: "expired" }));
  assert.equal(expired.selectable, false);
  assert.equal(expired.needsAttention, true);
  assert.equal(expired.summary, "sign-in expired");

  const needsAuth = projectSourceState(summary({ status: "needs-auth", auth: "none" }));
  assert.equal(needsAuth.selectable, false);
  assert.equal(needsAuth.needsAttention, true);
  assert.equal(needsAuth.summary, "sign-in required");

  const errored = projectSourceState(summary({ status: "error" }));
  assert.equal(errored.selectable, false);
  assert.equal(errored.needsAttention, true);
});

test("projectSourceState: ready but empty is not selectable; stale catalog is noted", () => {
  assert.equal(projectSourceState(summary({ modelCount: 0 })).selectable, false);
  assert.equal(projectSourceState(summary({ modelCount: 0 })).summary, "no models");
  const stale = projectSourceState(summary({ freshness: { refreshedAt: null, stale: true } }));
  assert.equal(stale.selectable, true, "stale catalog is still selectable");
  assert.equal(stale.summary, "2 models (catalog stale)");
});

test("the legacy provider string round-trips through a stable model ref", () => {
  const ref = modelRefFromProvider("qwen", "qwen3-coder", "high");
  assert.deepEqual(ref, { sourceId: "qwen", modelId: "qwen3-coder", reasoning: "high" });
  assert.equal(providerStringOf(ref), "qwen", "the provider string IS the source id");
  // Default reasoning is null when the caller does not pass one.
  assert.equal(modelRefFromProvider("qwen", "m").reasoning, null);
});

test("a legacy ProviderModel projects into a catalog entry under its provider source", () => {
  const pm: ProviderModel = {
    label: "Qwen3 Coder",
    model: "qwen3-coder",
    reasoningLevels: ["off", "low", "high"],
    defaultReasoning: "low",
    kind: "local",
  };
  const entry = catalogEntryFromProviderModel("qwen", pm);
  assert.equal(entry.sourceId, "qwen");
  assert.equal(entry.modelId, "qwen3-coder");
  assert.equal(entry.displayName, "Qwen3 Coder");
  assert.equal(entry.kind, "local");
  assert.deepEqual(entry.capabilities, ["reasoning"], "multiple reasoning levels -> reasoning cap");
  assert.equal(entry.contextLength, null);
  assert.deepEqual(entry.freshness, { refreshedAt: null, stale: false });

  // A single-reasoning-level model advertises no reasoning capability.
  const flat = catalogEntryFromProviderModel("x", { ...pm, reasoningLevels: ["off"] });
  assert.deepEqual(flat.capabilities, []);
});
