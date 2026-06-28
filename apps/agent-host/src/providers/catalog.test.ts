import assert from "node:assert/strict";
import { test } from "vitest";
import { buildCatalogSnapshot, buildSourceProvider } from "./catalog";

/**
 * D-065 turn resolution: buildSourceProvider builds a Provider for an arbitrary `{sourceId, modelId}`
 * from a known catalog source, so ANY catalog model runs (not just the registered keys). An unknown
 * source returns null, so the caller falls back to the legacy registered providers.
 *
 * buildCatalogSnapshot is the pure source/catalog read model: configured-state projection (from auth.json
 * key PRESENCE, never the value), summaries, local non-chat filtering, and entry shape - secret-free by
 * construction.
 */

const SECRET = "sk-super-secret-deepseek-key-1234567890";
// A configured DeepSeek + Z.ai (static keys present) and OAuth OpenAI (codex entry present); MiniMax
// and LM Studio left unconfigured / local.
const auth = {
  deepseek: { key: SECRET },
  zai: { key: "sk-zai-abc" },
  "openai-codex": { tokens: { access: "oauth-token" } },
};

test("buildCatalogSnapshot projects configured-state, summaries, and the per-source catalog", () => {
  const snap = buildCatalogSnapshot(auth, {
    deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
    zai: ["glm-5.2"],
    openai: ["gpt-5.5"],
    // minimax left out (unconfigured); lmstudio left out (no ids fetched)
  });
  const by = Object.fromEntries(snap.sources.map((s) => [s.sourceId, s]));

  // OpenAI is an OAuth (Cloud subscription) source, not direct-API.
  assert.equal(by.openai?.type, "oauth");
  assert.equal(by.openai?.status, "ready");

  // DeepSeek is configured -> ready/authenticated with its 2 models; the catalog carries them.
  assert.equal(by.deepseek?.status, "ready");
  assert.equal(by.deepseek?.auth, "authenticated");
  assert.equal(by.deepseek?.modelCount, 2);
  assert.deepEqual(by.deepseek?.actions, ["refresh"]);
  assert.deepEqual(
    snap.catalogBySource.deepseek?.map((e) => e.modelId),
    ["deepseek-v4-pro", "deepseek-v4-flash"],
  );

  // MiniMax has no key -> needs-auth, no models, a configure action; LM Studio (local) is always ready.
  assert.equal(by.minimax?.status, "needs-auth");
  assert.equal(by.minimax?.auth, "none");
  assert.equal(by.minimax?.modelCount, 0);
  assert.deepEqual(by.minimax?.actions, ["configure"]);
  assert.equal(by.lmstudio?.status, "ready");
});

test("buildCatalogSnapshot drops LM Studio non-chat models (embeddings, rerankers, filters)", () => {
  const snap = buildCatalogSnapshot(auth, {
    lmstudio: [
      "unsloth/qwen3.6-27b-mlx",
      "text-embedding-nomic-embed-text-v1.5",
      "gliner-relex-base-v1.0-mlx",
      "openai-privacy-filter",
      "qwen/qwen3-vl-8b",
    ],
  });
  assert.deepEqual(
    snap.catalogBySource.lmstudio?.map((e) => e.modelId),
    ["unsloth/qwen3.6-27b-mlx", "qwen/qwen3-vl-8b"],
    "embeddings / gliner / privacy-filter are filtered out",
  );
});

test("a catalog entry carries the model's reasoning surface + capabilities (from the pi-ai shape)", () => {
  const snap = buildCatalogSnapshot(auth, { zai: ["glm-5.2"] });
  const entry = snap.catalogBySource.zai?.[0];
  assert.equal(entry?.modelId, "glm-5.2");
  assert.equal(entry?.kind, "cloud");
  assert.ok(entry?.capabilities.includes("tools"), "tools is always present");
  // glm-5.2 reasons, so a non-empty reasoning surface + the reasoning capability are derived.
  assert.ok((entry?.reasoningLevels.length ?? 0) > 0, "a reasoning surface is derived");
  assert.ok(entry?.capabilities.includes("reasoning"));
});

test("REDACTION: the API key never appears in any announced source or catalog entry", () => {
  const snap = buildCatalogSnapshot(auth, {
    deepseek: ["deepseek-v4-pro"],
    zai: ["glm-5.2"],
  });
  // auth (with the secret key) flows in only as a configured signal; it must never reach the output.
  assert.ok(
    !JSON.stringify(snap).includes(SECRET),
    "the API key value must not leak into the announced read model",
  );
  assert.ok(!JSON.stringify(snap).includes("sk-zai-abc"));
});

test("builds a per-model provider for each known source type", () => {
  const zai = buildSourceProvider("zai", "glm-5.1");
  assert.equal(zai?.kind, "cloud");
  assert.equal(zai?.id, "zai");
  assert.equal(zai?.model, "glm-5.1");

  const openai = buildSourceProvider("openai", "gpt-5.5");
  assert.equal(openai?.kind, "cloud");
  assert.equal(openai?.model, "gpt-5.5");

  const local = buildSourceProvider("lmstudio", "qwen/qwen3-vl-8b");
  assert.equal(local?.kind, "local");
  assert.equal(local?.model, "qwen/qwen3-vl-8b");
});

test("an unknown source returns null (caller falls back to the registered providers)", () => {
  assert.equal(buildSourceProvider("nope", "whatever"), null);
});
