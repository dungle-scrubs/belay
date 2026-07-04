import assert from "node:assert/strict";
import {
  EMPTY_PREFERENCES,
  type ModelRef,
  modelRefKey,
  type ProviderModel,
  selectModel,
} from "@trevor/session";
import { test } from "vitest";
import {
  activeModelLabel,
  buildModelSelection,
  legacyToCatalog,
  sessionScopedKey,
  sortModelsByPreference,
} from "./model-selection";

/**
 * 02.16: the collapsed model button label resolves from the SELECTED catalog entry (per-model), not the
 * static per-provider roster label, and model-state keys are scoped per session.
 */

test("activeModelLabel prefers the selected catalog entry's displayName (the stale-label fix)", () => {
  // The reported defect: minimax provider with rosterLabel "MiniMax M2.7" but MiniMax-M3 selected.
  assert.equal(
    activeModelLabel({
      entry: { displayName: "MiniMax-M3" },
      registeredProvider: true,
      rosterLabel: "MiniMax M2.7",
      selectionLabel: "MiniMax-M3",
    }),
    "MiniMax-M3",
  );
});

test("activeModelLabel keeps the roster label for a legacy provider with no catalog entry", () => {
  assert.equal(
    activeModelLabel({
      entry: undefined,
      registeredProvider: true,
      rosterLabel: "Qwen3 Coder",
      selectionLabel: "ignored",
    }),
    "Qwen3 Coder",
  );
});

test("activeModelLabel falls back to the selection label for an unregistered provider with no entry", () => {
  assert.equal(
    activeModelLabel({
      entry: undefined,
      registeredProvider: false,
      rosterLabel: "ignored",
      selectionLabel: "GLM-5.2",
    }),
    "GLM-5.2",
  );
});

test("sessionScopedKey isolates sessions and shares within one; null defers to a throwaway key", () => {
  assert.notEqual(
    sessionScopedKey("trevor.provider", "A"),
    sessionScopedKey("trevor.provider", "B"),
  );
  assert.equal(sessionScopedKey("trevor.provider", "A"), sessionScopedKey("trevor.provider", "A"));
  assert.equal(sessionScopedKey("trevor.provider", null), "trevor.provider:pending");
});

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
    modelPrefs: { default: null, pinned: [] },
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

test("buildModelSelection sources pinnedKeys + defaultKey from the host modelPrefs (plan 51 M4)", () => {
  const def: ModelRef = { sourceId: "zai", modelId: "glm-5.2", reasoning: "high" };
  const pin: ModelRef = { sourceId: "lmstudio", modelId: "qwen3-30b", reasoning: null };

  const withDefault = buildModelSelection({
    preferences: EMPTY_PREFERENCES,
    modelPrefs: { default: def, pinned: [pin] },
    roster,
    hostSources: [],
    hostCatalog: {},
    legacyProvider: "qwen",
    legacyReasoning: null,
  });
  assert.equal(withDefault.defaultKey, "zai/glm-5.2", "defaultKey is the host default's ref key");
  assert.equal(
    withDefault.pinnedKeys.has("lmstudio/qwen3-30b"),
    true,
    "favorites come from the host",
  );
  // The effective preferences overlay the host default (so the initial-pick default reads off here).
  assert.deepEqual(withDefault.preferences.default, def);
  assert.deepEqual(withDefault.preferences.pinned, [pin]);

  const noDefault = buildModelSelection({
    preferences: EMPTY_PREFERENCES,
    modelPrefs: { default: null, pinned: [] },
    roster,
    hostSources: [],
    hostCatalog: {},
    legacyProvider: "qwen",
    legacyReasoning: null,
  });
  assert.equal(noDefault.defaultKey, null, "no host default -> defaultKey null");
  assert.equal(noDefault.pinnedKeys.size, 0);
});

test("sortModelsByPreference orders default -> favorites -> rest, stable, default+pinned once (M5)", () => {
  const rows: ModelRef[] = [
    { sourceId: "s", modelId: "a", reasoning: null },
    { sourceId: "s", modelId: "b", reasoning: null }, // the default (and also pinned below)
    { sourceId: "s", modelId: "c", reasoning: null }, // pinned
    { sourceId: "s", modelId: "d", reasoning: null },
    { sourceId: "s", modelId: "e", reasoning: null }, // pinned
  ];
  const pinnedKeys = new Set(["s/b", "s/c", "s/e"]);
  const sorted = sortModelsByPreference(rows, { defaultKey: "s/b", pinnedKeys });

  assert.deepEqual(
    sorted.map((r) => r.modelId),
    // default (b) first; then favorites in original order (c, e); then the rest in original order (a, d).
    ["b", "c", "e", "a", "d"],
  );
  // The default+pinned model (b) appears exactly once (in the default slot).
  assert.equal(sorted.filter((r) => modelRefKey(r) === "s/b").length, 1);

  // No default: favorites lead, the rest follow, each stable.
  const noDefault = sortModelsByPreference(rows, { defaultKey: null, pinnedKeys });
  assert.deepEqual(
    noDefault.map((r) => r.modelId),
    ["b", "c", "e", "a", "d"],
  );
});
