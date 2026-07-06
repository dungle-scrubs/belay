import assert from "node:assert/strict";
import { renderHook } from "@testing-library/react";
import type { ModelRef, ProviderModel } from "@trevor/session";
import { beforeEach, test } from "vitest";
import type { ModelPrefsView } from "@/derive";
import { sessionScopedKey } from "@/model-selection";
import { useActiveModel } from "./use-active-model";

/**
 * Plan 51 M6 (D-005): the initial-model pick consults the host DEFAULT - the "reset to qwen" fix. On a
 * fresh session (no per-session `active`) the pick must land on the user's host default, not the legacy
 * `DEFAULT_PROVIDER` fallback; an explicit per-session `active` still wins over the default. The pick is
 * `active ?? default ?? legacy`, so the default slots BETWEEN a session active and the legacy fallback.
 */

const hostModels: Record<string, ProviderModel> = {
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
    reasoningLevels: ["off", "high"],
    defaultReasoning: "high",
    kind: "cloud",
  },
};

const noop = () => {};

function harness(over: { sessionId: string; hostModelPrefs: ModelPrefsView }) {
  return renderHook(() =>
    useActiveModel({
      hostModels,
      hostSources: [],
      hostCatalog: {},
      hostModelPrefs: over.hostModelPrefs,
      provider: undefined,
      setProvider: noop,
      reasoningMap: undefined,
      setReasoningMap: noop,
      // The legacy host default provider (qwen) - what a fresh session used to reset to.
      hostDefault: "qwen",
      lastUserModel: null,
      sessionId: over.sessionId,
      activeRunId: null,
      switchModel: noop,
    }),
  );
}

beforeEach(() => localStorage.clear());

test("a fresh session starts on the host DEFAULT, not the legacy qwen fallback (the reset fix)", () => {
  const def: ModelRef = { sourceId: "deepseek", modelId: "deepseek-v4", reasoning: null };
  const { result } = harness({ sessionId: "fresh", hostModelPrefs: { default: def, pinned: [] } });
  assert.equal(result.current.sendModel.sourceId, "deepseek", "the default drives the fresh pick");
  assert.equal(result.current.sendModel.modelId, "deepseek-v4");
});

test("with NO host default, a fresh session still falls back to the legacy provider (qwen)", () => {
  const { result } = harness({
    sessionId: "fresh2",
    hostModelPrefs: { default: null, pinned: [] },
  });
  assert.equal(result.current.sendModel.sourceId, "qwen", "no default -> the legacy fallback");
});

test("an explicit per-session active wins over the host default", () => {
  // Seed a per-session active pick; the default must not override an in-session choice.
  localStorage.setItem(
    sessionScopedKey("trevor.modelPreferences", "with-active"),
    JSON.stringify({
      active: { sourceId: "qwen", modelId: "qwen3-coder", reasoning: "low" },
      reasoningByModel: {},
    }),
  );
  const def: ModelRef = { sourceId: "deepseek", modelId: "deepseek-v4", reasoning: null };
  const { result } = harness({
    sessionId: "with-active",
    hostModelPrefs: { default: def, pinned: [] },
  });
  assert.equal(result.current.sendModel.sourceId, "qwen", "the explicit session active wins");
});
