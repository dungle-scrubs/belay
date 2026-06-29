import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import type { ProviderModel } from "@trevor/session";
import { beforeEach, test } from "vitest";
import { useModelSelection } from "./use-model-selection";

/**
 * D-065 M3/M6: the model-selection state hook. Pins the active fallback (legacy provider selection
 * until an explicit pick), persisted selection with reasoning clamped to the chosen model's surface,
 * the recents feeding the quick picker, and the roster-projected sources/catalog.
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

beforeEach(() => localStorage.clear());

test("active falls back to the legacy provider selection until an explicit pick", () => {
  const { result } = renderHook(() =>
    useModelSelection({
      roster,
      hostSources: [],
      hostCatalog: {},
      legacyProvider: "deepseek",
      legacyReasoning: "high",
      sessionId: "s1",
    }),
  );
  assert.deepEqual(result.current.active, {
    sourceId: "deepseek",
    modelId: "deepseek-v4",
    reasoning: "high",
  });
  assert.equal(result.current.activeLabel, "DeepSeek V4 Pro");
  assert.deepEqual(result.current.quickGroups, [], "no recents before a pick");
});

test("select records the active + recent and clamps reasoning to the model's surface", () => {
  const { result } = renderHook(() =>
    useModelSelection({
      roster,
      hostSources: [],
      hostCatalog: {},
      legacyProvider: "qwen",
      legacyReasoning: "low",
      sessionId: "s1",
    }),
  );
  // Pick deepseek carrying an unsupported reasoning - it clamps to deepseek's surface default.
  act(() =>
    result.current.select({ sourceId: "deepseek", modelId: "deepseek-v4", reasoning: "low" }),
  );
  assert.equal(result.current.active?.sourceId, "deepseek");
  assert.equal(result.current.active?.reasoning, "high", "low not in surface -> default high");
  // The pick now leads the quick picker's recents.
  assert.equal(result.current.quickGroups[0]?.sourceId, "deepseek");
  assert.equal(result.current.quickGroups[0]?.models[0]?.modelId, "deepseek-v4");
});

test("sources/catalog are empty when the host has not reported them (no misleading roster projection)", () => {
  const { result } = renderHook(() =>
    useModelSelection({
      roster,
      hostSources: [],
      hostCatalog: {},
      legacyProvider: "qwen",
      legacyReasoning: null,
      sessionId: "s1",
    }),
  );
  // The roster is NOT projected into fake sources - the chooser shows an explicit empty state instead.
  assert.deepEqual(result.current.sources, []);
  assert.deepEqual(result.current.catalogBySource, {});
  // The active model still resolves (from the legacy roster) so the split control keeps a label.
  assert.equal(result.current.active?.sourceId, "qwen");
  assert.equal(result.current.activeLabel, "Qwen3 Coder");
});

test("the host-announced sources + catalog are preferred once they arrive (D-065)", () => {
  const hostSources = [
    {
      sourceId: "zai",
      type: "api-key" as const,
      label: "Z.ai",
      status: "ready" as const,
      modelCount: 2,
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
        capabilities: ["tools", "reasoning"],
        contextLength: 200000,
        costTier: null,
        aliases: [],
        freshness: { refreshedAt: null, stale: false },
        reasoningLevels: ["off", "high"],
        defaultReasoning: "high",
      },
    ],
  };
  const { result } = renderHook(() =>
    useModelSelection({
      roster,
      hostSources,
      hostCatalog,
      legacyProvider: "qwen",
      legacyReasoning: null,
      sessionId: "s1",
    }),
  );
  // The real host source wins over the roster projection (no "qwen"/"deepseek" projected sources).
  assert.deepEqual(
    result.current.sources.map((s) => s.sourceId),
    ["zai"],
  );
  assert.equal(result.current.catalogBySource.zai?.[0]?.modelId, "glm-5.2");
  // Labels come from the host source/catalog (source label vs model display name).
  assert.equal(result.current.sourceLabels.zai, "Z.ai");
  assert.equal(result.current.modelLabels["glm-5.2"], "GLM-5.2");
});

test("02.16: a model pick in one session is invisible to another (per-session persistence)", () => {
  // Session A picks deepseek; session B (a different sessionId) must NOT inherit it - the prefs are
  // keyed by sessionId, so the cross-session live-switch leak is gone.
  const sessionA = renderHook(() =>
    useModelSelection({
      roster,
      hostSources: [],
      hostCatalog: {},
      legacyProvider: "qwen",
      legacyReasoning: "low",
      sessionId: "A",
    }),
  );
  act(() =>
    sessionA.result.current.select({
      sourceId: "deepseek",
      modelId: "deepseek-v4",
      reasoning: "high",
    }),
  );
  assert.equal(sessionA.result.current.active?.sourceId, "deepseek", "session A applied its pick");

  const sessionB = renderHook(() =>
    useModelSelection({
      roster,
      hostSources: [],
      hostCatalog: {},
      legacyProvider: "qwen",
      legacyReasoning: "low",
      sessionId: "B",
    }),
  );
  // B still falls back to its legacy provider (qwen), unaffected by A's deepseek pick.
  assert.equal(sessionB.result.current.active?.sourceId, "qwen", "session B is isolated from A");
});

test("02.16: two views of the SAME session share the persisted pick", () => {
  const first = renderHook(() =>
    useModelSelection({
      roster,
      hostSources: [],
      hostCatalog: {},
      legacyProvider: "qwen",
      legacyReasoning: "low",
      sessionId: "shared",
    }),
  );
  act(() =>
    first.result.current.select({
      sourceId: "deepseek",
      modelId: "deepseek-v4",
      reasoning: "high",
    }),
  );
  // A second hook on the same sessionId reads the same persisted key.
  const second = renderHook(() =>
    useModelSelection({
      roster,
      hostSources: [],
      hostCatalog: {},
      legacyProvider: "qwen",
      legacyReasoning: "low",
      sessionId: "shared",
    }),
  );
  assert.equal(second.result.current.active?.sourceId, "deepseek", "same session shares the pick");
});
