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
    useModelSelection({ roster, legacyProvider: "deepseek", legacyReasoning: "high" }),
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
    useModelSelection({ roster, legacyProvider: "qwen", legacyReasoning: "low" }),
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

test("sources and catalog are projected from the announced roster", () => {
  const { result } = renderHook(() =>
    useModelSelection({ roster, legacyProvider: "qwen", legacyReasoning: null }),
  );
  assert.deepEqual(
    result.current.sources.map((s) => s.sourceId),
    ["qwen", "deepseek"],
  );
  assert.equal(result.current.catalogBySource.qwen?.[0]?.modelId, "qwen3-coder");
});
