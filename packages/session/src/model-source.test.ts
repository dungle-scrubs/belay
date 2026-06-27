import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CATALOG_PAGE_MAX,
  type CatalogEntry,
  catalogEntryFromProviderModel,
  decodeCatalogEntry,
  decodeModelRef,
  decodeSourceSummary,
  decodeSourceType,
  modelRefFromProvider,
  projectSourceState,
  providerStringOf,
  queryCatalog,
  resolveUserTurnModel,
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
    reasoningLevels: ["off", "low", "medium", "high"],
    defaultReasoning: "medium",
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
    reasoningLevels: ["off", "low", "medium", "high"],
    defaultReasoning: "medium",
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

const entry = (over: Partial<CatalogEntry> & { modelId: string }): CatalogEntry => ({
  sourceId: "gw",
  displayName: over.modelId,
  kind: "cloud",
  capabilities: [],
  contextLength: null,
  costTier: null,
  aliases: [],
  freshness: { refreshedAt: null, stale: false },
  reasoningLevels: [],
  defaultReasoning: "off",
  ...over,
});

test("queryCatalog filters by text, family, capability, kind, and context size", () => {
  const all = [
    entry({ modelId: "qwen3-coder", displayName: "Qwen3 Coder", capabilities: ["reasoning"] }),
    entry({ modelId: "gpt-vision", displayName: "GPT Vision", capabilities: ["vision", "tools"] }),
    entry({ modelId: "llama-local", kind: "local", contextLength: 8000, aliases: ["llama3"] }),
    entry({ modelId: "big-ctx", contextLength: 200000 }),
  ];
  assert.deepEqual(
    queryCatalog(all, { text: "coder" }).entries.map((e) => e.modelId),
    ["qwen3-coder"],
    "free text matches id/display",
  );
  assert.deepEqual(
    queryCatalog(all, { text: "llama3" }).entries.map((e) => e.modelId),
    ["llama-local"],
    "free text matches aliases",
  );
  assert.deepEqual(
    queryCatalog(all, { filters: { vision: true } }).entries.map((e) => e.modelId),
    ["gpt-vision"],
  );
  assert.deepEqual(
    queryCatalog(all, { filters: { kind: "local" } }).entries.map((e) => e.modelId),
    ["llama-local"],
  );
  assert.deepEqual(
    queryCatalog(all, { filters: { minContext: 100000 } }).entries.map((e) => e.modelId),
    ["big-ctx"],
  );
  assert.deepEqual(
    queryCatalog(all, { filters: { family: "gpt" } }).entries.map((e) => e.modelId),
    ["gpt-vision"],
  );
});

test("queryCatalog pages thousands of models with a cursor and a hard cap", () => {
  const all = Array.from({ length: 5000 }, (_, i) => entry({ modelId: `m${i}` }));

  const first = queryCatalog(all, { limit: 100 });
  assert.equal(first.entries.length, 100, "the page is bounded by the limit");
  assert.equal(first.total, 5000, "total reports the full match count, not the page size");
  assert.equal(first.nextCursor, 100, "the cursor advances by the page size");

  const second = queryCatalog(all, { cursor: first.nextCursor ?? 0, limit: 100 });
  assert.equal(second.entries[0]?.modelId, "m100", "the next page continues where the first ended");

  // A request beyond the hard cap is clamped, so a caller can never pull the whole catalog at once.
  const capped = queryCatalog(all, { limit: 100000 });
  assert.equal(capped.entries.length, CATALOG_PAGE_MAX);

  // The last page reports a null cursor (matches exhausted).
  const tail = queryCatalog(all, { cursor: 4950, limit: 100 });
  assert.equal(tail.entries.length, 50);
  assert.equal(tail.nextCursor, null);
});

test("queryCatalog returns stale entries (staleness is display, not exclusion) and an empty match cleanly", () => {
  const all = [
    entry({ modelId: "fresh" }),
    entry({ modelId: "old", freshness: { refreshedAt: null, stale: true } }),
  ];
  assert.deepEqual(
    queryCatalog(all).entries.map((e) => e.modelId),
    ["fresh", "old"],
    "a stale entry is still returned",
  );
  const none = queryCatalog(all, { text: "nomatch" });
  assert.deepEqual(none.entries, []);
  assert.equal(none.total, 0);
  assert.equal(none.nextCursor, null);
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

// --- D-065 migration: decodeModelRef + resolveUserTurnModel (the new-vs-legacy turn bridge) ---

test("decodeModelRef tolerates partial/garbled refs and defaults reasoning to null", () => {
  assert.deepEqual(decodeModelRef({ sourceId: "deepseek", modelId: "v4", reasoning: "high" }), {
    sourceId: "deepseek",
    modelId: "v4",
    reasoning: "high",
  });
  // Missing reasoning -> null (the provider default).
  assert.deepEqual(decodeModelRef({ sourceId: "qwen", modelId: "coder" }), {
    sourceId: "qwen",
    modelId: "coder",
    reasoning: null,
  });
  // Unusable shapes decode to null, never a throw.
  assert.equal(decodeModelRef({ sourceId: 5, modelId: "x" }), null);
  assert.equal(decodeModelRef({ modelId: "x" }), null);
  assert.equal(decodeModelRef(null), null);
  assert.equal(decodeModelRef("nope"), null);
});

test("resolveUserTurnModel: a present ModelRef wins over the legacy provider/reasoning", () => {
  const resolved = resolveUserTurnModel({
    model: { sourceId: "deepseek", modelId: "v4", reasoning: "high" },
    provider: "qwen",
    reasoning: "low",
  });
  assert.deepEqual(resolved, { sourceId: "deepseek", reasoning: "high" });
});

test("resolveUserTurnModel: a ModelRef with null reasoning means the provider default", () => {
  const resolved = resolveUserTurnModel({
    model: { sourceId: "deepseek", modelId: "v4", reasoning: null },
  });
  assert.deepEqual(resolved, { sourceId: "deepseek", reasoning: undefined });
});

test("resolveUserTurnModel: no ModelRef falls back to the legacy provider/reasoning strings", () => {
  assert.deepEqual(resolveUserTurnModel({ provider: "qwen", reasoning: "low" }), {
    sourceId: "qwen",
    reasoning: "low",
  });
  // An empty legacy turn yields undefined source (pickProvider then defaults it).
  assert.deepEqual(resolveUserTurnModel({}), { sourceId: undefined, reasoning: undefined });
});
