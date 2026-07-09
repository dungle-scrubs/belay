import assert from "node:assert/strict";
import { Effect } from "effect";
import { test } from "vitest";
import { buildCatalogSnapshot, buildSourceProvider } from "./catalog";
import { signInTargetFor } from "./provider-auth";

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

  // MiniMax has no key -> it is OMITTED entirely (a key-based source is advertised only when its key is
  // present; with none there is nothing to do in-app and no model to select). LM Studio (local) is
  // always ready.
  assert.equal(by.minimax, undefined, "an unconfigured api-key source is not advertised");
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

test("OpenRouter Grok 4.5 gets mandatory reasoning metadata before pi-ai knows the id", () => {
  const snap = buildCatalogSnapshot(
    { ...auth, openrouter: { key: "sk-or-test" } },
    {
      openrouter: [
        {
          id: "x-ai/grok-4.5",
          name: "xAI: Grok 4.5",
        },
      ],
    },
  );
  const entry = snap.catalogBySource.openrouter?.[0];
  assert.equal(entry?.modelId, "x-ai/grok-4.5");
  assert.equal(entry?.displayName, "xAI: Grok 4.5");
  assert.equal(entry?.contextLength, 200_000);
  assert.deepEqual(entry?.reasoningLevels, ["minimal", "low", "medium", "high"]);
  assert.equal(entry?.defaultReasoning, "medium");
  assert.ok(!entry?.reasoningLevels.includes("off"), "OpenRouter rejects disabled reasoning here");
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

  // an UNCONFIGURED key-based source is omitted entirely, so it never appears (stale or otherwise).
  const minimax = buildCatalogSnapshot(auth, {}, new Set(["minimax"])).sources.find(
    (s) => s.sourceId === "minimax",
  );
  assert.equal(minimax, undefined, "an unconfigured api-key source is not advertised");
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

test("the Claude subscription source dispatches to anthropicProvider, never the Agent-SDK route", () => {
  // 53.1 D-001: the `anthropic` oauth source streams Claude through the pi-ai OAuth provider
  // (anthropicProvider, id "anthropic"), NOT the deleted claude-code Agent-SDK route. The distinct id
  // proves the dispatch went to anthropicProvider and not codex (the other oauth branch).
  const sub = buildSourceProvider("anthropic", "claude-opus-4-0");
  assert.equal(sub?.kind, "cloud");
  assert.equal(sub?.id, "anthropic");
  assert.equal(sub?.model, "claude-opus-4-0");
});

test("the Anthropic Direct API source resolves to a static-key Claude provider on its distinct id", () => {
  // 53.1 D-001: the direct source is a plain static-key pi provider on the DISTINCT id "anthropic-api"
  // (freed so the OAuth subscription can own "anthropic"), reached with a key from ~/.pi/auth.json - NOT
  // an OAuth path (no getOAuthApiKey, no sign-in target).
  const a = buildSourceProvider("anthropic-api", "claude-opus-4-0");
  assert.equal(a?.kind, "cloud");
  assert.equal(a?.id, "anthropic-api");
  assert.equal(a?.model, "claude-opus-4-0");
});

test("the Agent-SDK claude-code route is gone: the module is deleted and no source resolves it (53.1 D-002)", async () => {
  // The claude-code module (claudeCodeProvider) is deleted, so nothing can import it; a dynamic import
  // fails. No catalog source id resolves to the old Agent-SDK route either.
  const deleted: string = "./claude-code";
  await assert.rejects(
    import(deleted),
    "claude-code.ts is deleted; claudeCodeProvider is unimportable",
  );
  assert.equal(
    buildSourceProvider("claude-code", "claude-opus-4-0"),
    null,
    "no source resolves the retired claude-code id",
  );
});

test("an unknown source returns null (caller falls back to the registered providers)", () => {
  assert.equal(buildSourceProvider("nope", "whatever"), null);
});

test("exactly ONE oauth Claude source exists: `anthropic`, 'Claude subscription', unconfigured action authenticate", () => {
  // 53.1 D-001: the ONE Claude subscription is the restored `anthropic` OAuth row (label "Claude
  // subscription"). Unconfigured (no ~/.pi/auth.json `anthropic` OAuth entry), it projects the in-app
  // `authenticate` sign-in action - NOT the setup-token `configure` the deleted claude-code row used.
  const snap = buildCatalogSnapshot(auth, {});
  const claudeOauth = snap.sources.filter((s) => s.type === "oauth" && s.label.includes("Claude"));
  assert.equal(claudeOauth.length, 1, "one Claude subscription oauth source");
  assert.equal(claudeOauth[0]?.sourceId, "anthropic");
  assert.equal(claudeOauth[0]?.label, "Claude subscription");
  assert.equal(claudeOauth[0]?.status, "needs-auth");
  assert.deepEqual(claudeOauth[0]?.actions, ["authenticate"], "a real sign-in, never configure");
  // The retired claude-code oauth source is gone.
  assert.equal(
    snap.sources.some((s) => s.sourceId === "claude-code"),
    false,
    "no claude-code source remains",
  );
});

test("the Anthropic Direct API is an api-key source, advertised only when its key is present (53.1 D-001)", () => {
  // Peer to DeepSeek / Z.ai / MiniMax: its source id + configured signal are the DISTINCT `anthropic-api`
  // entry (freed so the Claude subscription OAuth owns `anthropic`), and it is NOT an OAuth connection.
  // With no `~/.pi/auth.json` `anthropic-api` key it is OMITTED - a Direct API source has no in-app
  // sign-in and no selectable model without its key, so it is never shown with a needs-auth prompt.
  const cold = buildCatalogSnapshot(auth, {}).sources.find((s) => s.sourceId === "anthropic-api");
  assert.equal(
    cold,
    undefined,
    "an unconfigured Direct API source is omitted, not shown as needs-auth",
  );

  // With the key present it appears like any other configured api-key source: ready, its models, refresh.
  const ANTHROPIC_KEY = "sk-ant-direct-DO-NOT-LEAK-0987654321";
  const withKey = buildCatalogSnapshot(
    { ...auth, "anthropic-api": { key: ANTHROPIC_KEY } },
    { "anthropic-api": ["claude-opus-4-8", "claude-sonnet-4-6"] },
  );
  const hot = withKey.sources.find((s) => s.sourceId === "anthropic-api");
  assert.equal(hot?.type, "api-key");
  assert.equal(hot?.label, "Anthropic Direct API");
  assert.equal(hot?.status, "ready");
  assert.equal(hot?.auth, "authenticated");
  assert.equal(hot?.modelCount, 2);
  assert.deepEqual(hot?.actions, ["refresh"]);
  // REDACTION: the direct key value never reaches the announced snapshot.
  assert.ok(!JSON.stringify(withKey).includes(ANTHROPIC_KEY));
});

test("the OAuth sign-in belongs to the Claude subscription (`anthropic`), never the Direct API (`anthropic-api`)", () => {
  // Regression for the mixed-up chooser (old host): the OAuth authorization flow was appearing on the
  // Anthropic Direct API row. It cannot: the device-code flow is stamped with the sourceId the sign-in
  // was STARTED for, and only `anthropic` (the Claude subscription) has a sign-in target.
  const snap = buildCatalogSnapshot({}, {}); // no Claude OAuth entry, no anthropic-api key
  // The Direct API (api-key) is not advertised without its key, so it can never render an auth prompt.
  assert.equal(
    snap.sources.find((s) => s.sourceId === "anthropic-api"),
    undefined,
    "the Direct API is not advertised (and shows no OAuth) without a key",
  );
  // The Claude Code subscription (oauth) IS advertised, with the in-app sign-in action ("Sign in").
  const sub = snap.sources.find((s) => s.sourceId === "anthropic");
  assert.equal(sub?.type, "oauth");
  assert.equal(sub?.label, "Claude subscription");
  assert.deepEqual(
    sub?.actions,
    ["authenticate"],
    "the Claude subscription signs in, never configure",
  );
  // Only the oauth source has a sign-in target; the Direct API has none, so a device-code flow (stamped
  // with the started sourceId) can never attach to `anthropic-api`.
  assert.ok(signInTargetFor("anthropic"), "the Claude subscription can start an OAuth sign-in");
  assert.equal(signInTargetFor("anthropic-api"), null, "the Direct API has no OAuth flow");
});

test("the Claude subscription source is oauth + tool-capable, and needs-auth without its OAuth entry", () => {
  // 53.1 D-001: with the ~/.pi/auth.json `anthropic` OAuth entry present the subscription is ready and
  // selectable; without it, it is announced but needs-auth (no catalog) with the `authenticate` action.
  // It streams via pi-ai, so it is tool-capable (its catalog entries carry the Tools chip).
  const withOauth = buildCatalogSnapshot(
    { anthropic: { type: "oauth", access: "sk-ant-oat" } },
    { anthropic: ["claude-opus-4-0"] },
  );
  const on = withOauth.sources.find((s) => s.sourceId === "anthropic");
  assert.equal(on?.type, "oauth");
  assert.equal(on?.label, "Claude subscription");
  assert.equal(on?.status, "ready");
  assert.ok((on?.modelCount ?? 0) > 0, "selectable: at least one model");
  const entry = withOauth.catalogBySource.anthropic?.[0];
  assert.ok(entry?.capabilities.includes("tools"), "tool-capable via pi-ai (Tools chip present)");

  const without = buildCatalogSnapshot({}, {}).sources.find((s) => s.sourceId === "anthropic");
  assert.equal(without?.status, "needs-auth");
  assert.equal(without?.modelCount, 0);
  assert.deepEqual(without?.actions, ["authenticate"]);
});

test("D-004 drift guard: the catalog's Claude subscription Tools chip agrees with capabilities().tools", () => {
  // The Tools capability is encoded twice - the SourceDef's toolCapable projection (the chooser chip)
  // and the provider's capabilities().tools (what the turn actually offers the model). They must agree,
  // or the chooser would advertise a capability the turn drops (or vice versa). Both are now true.
  const snap = buildCatalogSnapshot(
    { anthropic: { type: "oauth", access: "sk-ant-oat" } },
    { anthropic: ["claude-opus-4-0"] },
  );
  const entry = snap.catalogBySource.anthropic?.[0];
  assert.ok(entry, "the configured source carries a catalog entry");

  const provider = buildSourceProvider("anthropic", "claude-opus-4-0");
  assert.ok(provider, "the source resolves to a provider");
  const providerTools = Effect.runSync(provider.capabilities()).tools;
  assert.equal(
    entry.capabilities.includes("tools"),
    providerTools,
    "the SourceDef toolCapable projection and the provider's capabilities().tools must agree (D-004)",
  );
});

test("OpenRouter is a gateway source, advertised only when its key is present", () => {
  // openrouter has no key in this auth -> omitted (a key-based gateway is advertised only when configured).
  assert.equal(
    buildCatalogSnapshot(auth, {}).sources.find((s) => s.sourceId === "openrouter"),
    undefined,
    "an unconfigured gateway is not advertised",
  );
  // With a key it is announced as a gateway.
  const snap = buildCatalogSnapshot(
    { ...auth, openrouter: { key: "sk-or-abc" } },
    { openrouter: ["anthropic/claude-opus-4"] },
  );
  const or = snap.sources.find((s) => s.sourceId === "openrouter");
  assert.equal(or?.type, "gateway");
  assert.equal(or?.label, "OpenRouter");
  assert.equal(or?.status, "ready");
  assert.deepEqual(or?.actions, ["refresh"]);
});

test("Ollama Cloud is a gateway source: omitted without a key, ready with its live models", () => {
  const without = buildCatalogSnapshot(auth, {});
  assert.equal(
    without.sources.find((s) => s.sourceId === "ollama"),
    undefined,
    "an unconfigured gateway is not advertised",
  );

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

test("an EXPIRED oauth source projects needs-auth/expired with the reauthenticate pathway", () => {
  // The wedged shape this pins: the ~/.pi/auth.json `anthropic` entry EXISTS (so the source is
  // configured) but its credential can no longer mint a key (loadCatalog's probe failed - token
  // expired + refresh rejected). Present-but-dead must NOT read as authenticated/ready with only a
  // refresh action: that shows a healthy source with no re-auth pathway while every turn fails.
  const withClaude = { ...auth, anthropic: { type: "oauth", refresh: "r", expires: 1 } };
  const snap = buildCatalogSnapshot(
    withClaude,
    { anthropic: ["claude-opus-4-0"] },
    new Set(),
    undefined,
    new Set(["anthropic"]),
  );
  const claude = snap.sources.find((s) => s.sourceId === "anthropic");
  assert.equal(claude?.status, "needs-auth", "a dead credential is not ready");
  assert.equal(claude?.auth, "expired", "expired, not authenticated - drives the web auth panel");
  assert.deepEqual(claude?.actions, ["reauthenticate"], "the sign-in pathway is offered");
  // No browsable catalog for a source that cannot run anything: the chooser shows the re-auth
  // panel with the sign-in empty-state instead of a list of dead entries.
  assert.equal(claude?.modelCount, 0, "an expired source advertises no models");
  assert.deepEqual(snap.catalogBySource.anthropic, [], "and carries no catalog entries");
  // The other oauth source (openai, probe passed) keeps its healthy projection.
  const openai = snap.sources.find((s) => s.sourceId === "openai");
  assert.equal(openai?.status, "ready");
  assert.deepEqual(openai?.actions, ["refresh"]);
});

test("expiredSources only demotes a CONFIGURED source (an absent entry stays plain needs-auth/none)", () => {
  // No anthropic entry at all: even if a stale probe result names it, the projection stays the
  // unconfigured shape (auth "none" + "authenticate"), never a misleading "expired" for a source
  // that was never signed in.
  const snap = buildCatalogSnapshot(auth, {}, new Set(), undefined, new Set(["anthropic"]));
  const claude = snap.sources.find((s) => s.sourceId === "anthropic");
  assert.equal(claude?.status, "needs-auth");
  assert.equal(claude?.auth, "none");
  assert.deepEqual(claude?.actions, ["authenticate"]);
});
