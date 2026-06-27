import assert from "node:assert/strict";
import type { ProviderModel } from "@trevor/session";
import { test } from "vitest";
import {
  catalogFromRoster,
  legacyActiveRef,
  reasoningSurfaceOf,
  rosterLabels,
  sourcesFromRoster,
} from "./model-selection";

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

test("sourcesFromRoster makes one ready source per provider, typed by run location", () => {
  const sources = sourcesFromRoster(roster);
  assert.deepEqual(
    sources.map((s) => ({ id: s.sourceId, type: s.type, status: s.status, count: s.modelCount })),
    [
      { id: "qwen", type: "local", status: "ready", count: 1 },
      { id: "deepseek", type: "api-key", status: "ready", count: 1 },
    ],
  );
});

test("catalogFromRoster projects one catalog entry per provider via the bridge", () => {
  const catalog = catalogFromRoster(roster);
  assert.deepEqual(Object.keys(catalog), ["qwen", "deepseek"]);
  const [entry] = catalog.deepseek ?? [];
  assert.equal(entry?.modelId, "deepseek-v4");
  assert.equal(entry?.displayName, "DeepSeek V4 Pro");
  assert.equal(entry?.kind, "cloud");
  assert.deepEqual(
    entry?.capabilities,
    ["reasoning"],
    "multiple reasoning levels -> reasoning cap",
  );
});

test("reasoningSurfaceOf returns the model's levels + default, empty for an unknown source", () => {
  assert.deepEqual(reasoningSurfaceOf(roster, { sourceId: "deepseek" }), {
    levels: ["off", "high", "xhigh"],
    default: "high",
  });
  assert.deepEqual(reasoningSurfaceOf(roster, { sourceId: "ghost" }), {
    levels: [],
    default: "off",
  });
});

test("rosterLabels maps source ids and model ids to their display labels", () => {
  const { sourceLabels, modelLabels } = rosterLabels(roster);
  assert.equal(sourceLabels.qwen, "Qwen3 Coder");
  assert.equal(modelLabels["deepseek-v4"], "DeepSeek V4 Pro");
});

test("legacyActiveRef projects the current provider+reasoning selection, null before the roster", () => {
  assert.deepEqual(legacyActiveRef(roster, "deepseek", "xhigh"), {
    sourceId: "deepseek",
    modelId: "deepseek-v4",
    reasoning: "xhigh",
  });
  // Before host.online (empty roster) there is no model id to resolve, so callers fall back.
  assert.equal(legacyActiveRef({}, "deepseek", "high"), null);
});
