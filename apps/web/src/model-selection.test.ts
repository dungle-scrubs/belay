import assert from "node:assert/strict";
import { EMPTY_PREFERENCES, type ProviderModel, selectModel } from "@trevor/session";
import { test } from "vitest";
import { buildModelSelection, legacyToCatalog } from "./model-selection";

/**
 * D-065 M3: the migration projection from the legacy provider roster (host.online `models`) into the
 * chooser's source/catalog contract. Pins source projection (local vs cloud -> type), the catalog
 * bridge, the reasoning surface, label maps, and the legacy-active fallback.
 */

const roster: Record<string, ProviderModel> = {
  qwen: {
    label: "Qwen3 Coder",
    model: "qwen3-coder",
    reasoningLevels: ["off", "low", "high"],
    defaultReasoning: "low",
    kind: "local",
  },
  deepseek: {
    label: "DeepSeek V4 Pro",
    model: "deepseek-v4",
    reasoningLevels: ["off", "high", "xhigh"],
    defaultReasoning: "high",
    kind: "cloud",
  },
};

test("legacyToCatalog bridges roster labels and legacy operations onto host catalog data", () => {
  const hostSources = [
    {
      sourceId: "zai",
      type: "api-key" as const,
      label: "Z.ai",
      status: "ready" as const,
      modelCount: 1,
      auth: "authenticated" as const,
      freshness: { refreshedAt: null, stale: false },
      actions: [],
    },
  ];
  const hostCatalog = {
    zai: [
      {
        sourceId: "zai",
        modelId: "glm-5.2",
        displayName: "GLM-5.2",
        kind: "cloud" as const,
        capabilities: ["reasoning"],
        contextLength: 200000,
        costTier: null,
        aliases: [],
        freshness: { refreshedAt: null, stale: false },
        reasoningLevels: ["off", "high"],
        defaultReasoning: "high",
      },
    ],
  };

  const bridge = legacyToCatalog(roster, hostSources, hostCatalog);

  assert.deepEqual(
    bridge.sources.map((s) => s.sourceId),
    ["zai"],
    "host sources are not replaced with fake roster-projected sources",
  );
  assert.equal(bridge.catalogBySource.zai?.[0]?.modelId, "glm-5.2");
  assert.equal(bridge.sourceLabels.qwen, "Qwen3 Coder");
  assert.equal(bridge.sourceLabels.zai, "Z.ai");
  assert.equal(bridge.modelLabels["deepseek-v4"], "DeepSeek V4 Pro");
  assert.equal(bridge.modelLabels["glm-5.2"], "GLM-5.2");
  assert.deepEqual(bridge.reasoningSurface({ sourceId: "deepseek" }), {
    levels: ["off", "high", "xhigh"],
    default: "high",
  });
  assert.deepEqual(bridge.reasoningSurface({ sourceId: "ghost" }), {
    levels: [],
    default: "off",
  });
  assert.deepEqual(bridge.legacyActiveRef("deepseek", "xhigh"), {
    sourceId: "deepseek",
    modelId: "deepseek-v4",
    reasoning: "xhigh",
  });
  assert.equal(legacyToCatalog({}, [], {}).legacyActiveRef("deepseek", "high"), null);
});

test("buildModelSelection derives the chooser read model from preferences plus host catalog", () => {
  const preferences = selectModel(
    EMPTY_PREFERENCES,
    { sourceId: "zai", modelId: "glm-5.2", reasoning: "high" },
    { levels: ["off", "high"], default: "high" },
  );
  const hostSources = [
    {
      sourceId: "zai",
      type: "api-key" as const,
      label: "Z.ai",
      status: "ready" as const,
      modelCount: 1,
      auth: "authenticated" as const,
      freshness: { refreshedAt: null, stale: false },
      actions: [],
    },
  ];
  const hostCatalog = {
    zai: [
      {
        sourceId: "zai",
        modelId: "glm-5.2",
        displayName: "GLM-5.2",
        kind: "cloud" as const,
        capabilities: ["reasoning"],
        contextLength: 200000,
        costTier: null,
        aliases: [],
        freshness: { refreshedAt: null, stale: false },
        reasoningLevels: ["off", "high"],
        defaultReasoning: "high",
      },
    ],
  };

  const selection = buildModelSelection({
    preferences,
    roster,
    hostSources,
    hostCatalog,
    legacyProvider: "qwen",
    legacyReasoning: "low",
  });

  assert.equal(selection.active?.sourceId, "zai");
  assert.equal(selection.activeLabel, "GLM-5.2");
  assert.deepEqual(
    selection.sources.map((s) => s.sourceId),
    ["zai"],
  );
  assert.equal(selection.sourceLabels.qwen, "Qwen3 Coder");
  assert.equal(selection.sourceLabels.zai, "Z.ai");
  assert.equal(selection.quickGroups[0]?.sourceId, "zai");
  assert.equal(selection.recentKeys.has("zai/glm-5.2"), true);
});
