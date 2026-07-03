import assert from "node:assert/strict";
import { Effect } from "effect";
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

test("a LOCAL entry derives capabilities, vision, context, and quantization from the native record", () => {
  // Two same-id quants + a VLM + a non-tool model, each carrying its LM Studio native /api/v0 record.
  const snap = buildCatalogSnapshot(auth, {
    lmstudio: [
      {
        id: "unsloth/qwen3.6-27b-mlx",
        native: {
          id: "unsloth/qwen3.6-27b-mlx",
          type: "llm",
          arch: "qwen3",
          quantization: "8bit",
          maxContextLength: 262144,
          capabilities: ["tool_use"],
        },
      },
      {
        id: "qwen/qwen3-vl-8b",
        native: { id: "qwen/qwen3-vl-8b", type: "vlm", quantization: "4bit", capabilities: [] },
      },
    ],
  });
  const by = Object.fromEntries((snap.catalogBySource.lmstudio ?? []).map((e) => [e.modelId, e]));

  // The tool-capable LLM: tools (from tool_use) + reasoning (the local thinking toggle), NO vision,
  // native context + quantization + arch carried.
  const qwen = by["unsloth/qwen3.6-27b-mlx"];
  assert.ok(qwen?.capabilities.includes("tools"), "tool_use -> Tools chip");
  assert.ok(qwen?.capabilities.includes("reasoning"));
  assert.ok(!qwen?.capabilities.includes("vision"), "an llm is not vision");
  assert.equal(qwen?.contextLength, 262144, "context comes from native max_context_length");
  assert.equal(qwen?.quantization, "8bit");
  assert.equal(qwen?.arch, "qwen3");

  // The VLM with no tool_use: Vision (from type:vlm) but NOT Tools (capabilities lacked tool_use).
  const vl = by["qwen/qwen3-vl-8b"];
  assert.ok(vl?.capabilities.includes("vision"), "type:vlm -> Vision chip");
  assert.ok(!vl?.capabilities.includes("tools"), "no tool_use -> no Tools chip");
  assert.equal(vl?.quantization, "4bit");
});

test("a LOCAL entry with NO native record degrades to id-only: no tools/vision/quant, no crash", () => {
  // A bare-id local model (native /api/v0 was down) keeps the reasoning toggle but gains no fabricated
  // tools/vision/quant (D-006) - the disambiguating metadata is simply absent, the model still lists.
  const snap = buildCatalogSnapshot(auth, { lmstudio: ["unsloth/qwen3.6-27b-mlx"] });
  const entry = snap.catalogBySource.lmstudio?.[0];
  assert.equal(entry?.modelId, "unsloth/qwen3.6-27b-mlx");
  assert.equal(entry?.kind, "local");
  assert.ok(!entry?.capabilities.includes("tools"), "no fabricated Tools without a native record");
  assert.ok(
    !entry?.capabilities.includes("vision"),
    "no fabricated Vision without a native record",
  );
  assert.ok(entry?.capabilities.includes("reasoning"), "the local reasoning toggle still applies");
  assert.equal(entry?.contextLength, null, "no native context -> null (override may still set it)");
  assert.ok(!("quantization" in (entry ?? {})), "no quantization without a native record");
  assert.ok(!("arch" in (entry ?? {})), "no arch without a native record");
});

test("CLOUD entries never carry quantization/arch and keep the pi-ai capability derivation (D-005)", () => {
  const snap = buildCatalogSnapshot(auth, { zai: ["glm-5.2"] });
  const entry = snap.catalogBySource.zai?.[0];
  assert.ok(entry?.capabilities.includes("tools"), "cloud tools stays always-on");
  assert.ok(!("quantization" in (entry ?? {})), "no quantization on a cloud entry");
  assert.ok(!("arch" in (entry ?? {})), "no arch on a cloud entry");
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

test("a model pi-ai doesn't know uses the provider's live display name, not the raw id", () => {
  // openrouter (gateway) configured with a key; its live /models carries a name for an id pi-ai's
  // registry has never heard of - the entry shows that name, fixing label consistency.
  const snap = buildCatalogSnapshot(
    { ...auth, openrouter: { key: "sk-or-test" } },
    { openrouter: [{ id: "sakana/fugu-ultra", name: "Sakana: Fugu Ultra" }] },
  );
  const entry = snap.catalogBySource.openrouter?.[0];
  assert.equal(entry?.modelId, "sakana/fugu-ultra");
  assert.equal(entry?.displayName, "Sakana: Fugu Ultra");
});

test("a model with neither a registry entry nor a live name falls back to its id", () => {
  // ollama ids (e.g. gpt-oss:120b) are already readable, and its /v1/models carries no name - the id
  // is the label, and a bare-id input still works (normalized to a LiveModel).
  const snap = buildCatalogSnapshot(
    { ...auth, ollama: { key: "ollama-test" } },
    { ollama: ["gpt-oss:120b"] },
  );
  assert.equal(snap.catalogBySource.ollama?.[0]?.displayName, "gpt-oss:120b");
});

test("a configured source whose live /models fetch failed is flagged catalog-stale", () => {
  // openrouter configured; its live query is in the stale set (it failed and fell back to the static
  // registry), so the summary + its entries read stale and the chooser shows "(catalog stale)".
  const snap = buildCatalogSnapshot(
    { ...auth, openrouter: { key: "sk-or" } },
    { deepseek: ["deepseek-v4-pro"], openrouter: ["anthropic/claude-3.5-sonnet"] },
    new Set(["openrouter"]),
  );
  const or = snap.sources.find((s) => s.sourceId === "openrouter");
  assert.equal(or?.freshness.stale, true, "the failed-fetch source is stale");
  assert.equal(snap.catalogBySource.openrouter?.[0]?.freshness.stale, true, "entries carry it too");

  // deepseek fetched fine (not in the stale set) -> fresh.
  const ds = snap.sources.find((s) => s.sourceId === "deepseek");
  assert.equal(ds?.freshness.stale, false);

  // an UNCONFIGURED source is never "stale" (it has no catalog to be stale), even if named.
  const minimax = buildCatalogSnapshot(auth, {}, new Set(["minimax"])).sources.find(
    (s) => s.sourceId === "minimax",
  );
  assert.equal(minimax?.freshness.stale, false);
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

test("the OpenRouter gateway resolves any of its upstream models to a runnable provider", () => {
  const or = buildSourceProvider("openrouter", "anthropic/claude-3.5-sonnet");
  assert.equal(or?.kind, "cloud");
  assert.equal(or?.id, "openrouter");
  assert.equal(or?.model, "anthropic/claude-3.5-sonnet");
});

test("Ollama Cloud (no pi-ai registry) resolves any live model id to a runnable provider", () => {
  // Ollama has no piProvider, so this exercises the registry-less OpenAI-compatible branch: the
  // Model is built directly from the fixed base URL, not cloned from a sibling.
  const ollama = buildSourceProvider("ollama", "gpt-oss:120b");
  assert.equal(ollama?.kind, "cloud");
  assert.equal(ollama?.id, "ollama");
  assert.equal(ollama?.model, "gpt-oss:120b");
});

test("the Anthropic OAuth source resolves to a Claude provider", () => {
  const a = buildSourceProvider("anthropic", "claude-opus-4-0");
  assert.equal(a?.kind, "cloud");
  assert.equal(a?.id, "anthropic");
  assert.equal(a?.model, "claude-opus-4-0");
});

test("an unknown source returns null (caller falls back to the registered providers)", () => {
  assert.equal(buildSourceProvider("nope", "whatever"), null);
});

test("Anthropic is announced as an OAuth source needing sign-in until configured", () => {
  // `auth` configures openai-codex but not anthropic, so anthropic reads needs-auth with a sign-in action.
  const snap = buildCatalogSnapshot(auth, {});
  const a = snap.sources.find((s) => s.sourceId === "anthropic");
  assert.equal(a?.type, "oauth");
  assert.equal(a?.status, "needs-auth");
  assert.deepEqual(a?.actions, ["authenticate"]);
});

test("OpenRouter is announced as a gateway source", () => {
  // openrouter has no key in this auth, so it reads needs-auth with a configure action.
  const snap = buildCatalogSnapshot(auth, {});
  const or = snap.sources.find((s) => s.sourceId === "openrouter");
  assert.equal(or?.type, "gateway");
  assert.equal(or?.label, "OpenRouter");
  assert.equal(or?.status, "needs-auth");
  assert.deepEqual(or?.actions, ["configure"]);
});

test("claude-code configured signal is the CLI token, INDEPENDENT of ~/.pi/auth.json (both cross cases)", () => {
  // present-pi + absent-token = NOT configured: the anthropic OAuth entry is a DIFFERENT store than
  // the CLI token store the subprocess reads (D-003), so it must not mark claude-code ready.
  const piPresentNoToken = buildCatalogSnapshot(
    { anthropic: { type: "oauth", access: "tok" } },
    {},
    new Set(),
    undefined,
    {},
  );
  const a1 = piPresentNoToken.sources.find((s) => s.sourceId === "claude-code");
  assert.equal(
    a1?.status,
    "needs-auth",
    "pi anthropic entry present but no CLI token -> not configured",
  );

  // absent-pi + present-token = configured, purely off the CLI token.
  const tokenNoPi = buildCatalogSnapshot(
    {},
    { "claude-code": ["claude-opus-4-0"] },
    new Set(),
    undefined,
    { CLAUDE_CODE_OAUTH_TOKEN: "max-tok" },
  );
  const a2 = tokenNoPi.sources.find((s) => s.sourceId === "claude-code");
  assert.equal(a2?.status, "ready", "CLI token present (pi anthropic absent) -> configured");
  // The anthropic source itself stays needs-auth (its own ~/.pi store is empty) - the two are independent.
  const anthropic = tokenNoPi.sources.find((s) => s.sourceId === "anthropic");
  assert.equal(anthropic?.status, "needs-auth");
});

test("claude-code is a distinct, selectable Claude source: tools:false, not ready without the token", () => {
  const withToken = buildCatalogSnapshot(
    {},
    { "claude-code": ["claude-opus-4-0"] },
    new Set(),
    undefined,
    { CLAUDE_CODE_OAUTH_TOKEN: "max-tok" },
  );
  const cc = withToken.sources.find((s) => s.sourceId === "claude-code");
  assert.equal(cc?.type, "oauth");
  assert.notEqual(
    cc?.label,
    "Anthropic (Claude)",
    "the label is distinct from the anthropic source",
  );
  assert.equal(cc?.status, "ready");
  assert.ok((cc?.modelCount ?? 0) > 0, "selectable: at least one model");
  const entry = withToken.catalogBySource["claude-code"]?.[0];
  assert.ok(!entry?.capabilities.includes("tools"), "text-only source: no Tools chip (D-004)");

  // Without the token the source is still announced, but needs-auth (no catalog), with a manual
  // configure action - it has no in-app OAuth flow (the token comes from `claude setup-token`).
  const without = buildCatalogSnapshot({}, {}, new Set(), undefined, {});
  const ccOff = without.sources.find((s) => s.sourceId === "claude-code");
  assert.equal(ccOff?.status, "needs-auth");
  assert.equal(ccOff?.modelCount, 0);
  assert.deepEqual(ccOff?.actions, ["configure"]);
});

test("D-004 drift guard: the catalog's claude-code Tools chip agrees with capabilities().tools", () => {
  // The text-only limitation is encoded twice - the SourceDef's toolCapable flag (the chooser chip)
  // and the provider's capabilities().tools (what the host actually offers the model). They must
  // agree, or the chooser would advertise a capability the turn drops (or vice versa).
  const snap = buildCatalogSnapshot(
    {},
    { "claude-code": ["claude-opus-4-0"] },
    new Set(),
    undefined,
    { CLAUDE_CODE_OAUTH_TOKEN: "max-tok" },
  );
  const entry = snap.catalogBySource["claude-code"]?.[0];
  assert.ok(entry, "the configured source carries a catalog entry");

  const provider = buildSourceProvider("claude-code", "claude-opus-4-0");
  assert.ok(provider, "the source resolves to a provider");
  const providerTools = Effect.runSync(provider.capabilities()).tools;
  assert.equal(
    entry.capabilities.includes("tools"),
    providerTools,
    "the SourceDef toolCapable flag and the provider's capabilities().tools must agree (D-004)",
  );
});

test("the claude-code source resolves to a ClaudeCodeProvider, and anthropic is unchanged", () => {
  const cc = buildSourceProvider("claude-code", "claude-opus-4-0");
  assert.equal(cc?.id, "claude-code");
  assert.equal(cc?.kind, "cloud");
  assert.equal(cc?.model, "claude-opus-4-0");

  // No regression: the anthropic OAuth source still resolves to the anthropic provider.
  const a = buildSourceProvider("anthropic", "claude-opus-4-0");
  assert.equal(a?.id, "anthropic");
  assert.equal(a?.model, "claude-opus-4-0");
});

test("Ollama Cloud is a gateway source: needs-auth without a key, ready with its live models", () => {
  const without = buildCatalogSnapshot(auth, {});
  const needsAuth = without.sources.find((s) => s.sourceId === "ollama");
  assert.equal(needsAuth?.type, "gateway");
  assert.equal(needsAuth?.label, "Ollama Cloud");
  assert.equal(needsAuth?.status, "needs-auth");
  assert.deepEqual(needsAuth?.actions, ["configure"]);

  // With an ollama key present, its live model ids form the catalog (no pi-ai registry to enrich from,
  // so entries carry the raw id as the display name).
  const OLLAMA_SECRET = "ollama-cloud-key-9f8e7d6c5b4a";
  const configured = buildCatalogSnapshot(
    { ...auth, ollama: { key: OLLAMA_SECRET } },
    { ollama: ["gpt-oss:120b", "qwen3-coder:480b-cloud", "glm-5:cloud"] },
  );
  const ready = configured.sources.find((s) => s.sourceId === "ollama");
  assert.equal(ready?.status, "ready");
  assert.equal(ready?.auth, "authenticated");
  assert.equal(ready?.modelCount, 3);
  assert.deepEqual(
    configured.catalogBySource.ollama?.map((e) => e.modelId),
    ["gpt-oss:120b", "qwen3-coder:480b-cloud", "glm-5:cloud"],
  );
  // REDACTION: the ollama key value never reaches the announced snapshot.
  assert.ok(!JSON.stringify(configured).includes(OLLAMA_SECRET));
});
