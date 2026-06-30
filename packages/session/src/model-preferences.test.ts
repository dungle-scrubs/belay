import assert from "node:assert/strict";
import { test } from "vitest";
import {
  constrainReasoning,
  decodeModelPreferences,
  EMPTY_PREFERENCES,
  type ModelPreferences,
  modelRefKey,
  pinModel,
  quickPickerModels,
  RECENT_LIMIT,
  reasoningForModel,
  selectModel,
  setDefaultModel,
  unpinModel,
} from "./model-preferences";
import { type ModelRef, modelRefFromProvider } from "./model-source";

/**
 * D-065 M6: the pure model-selection + reasoning preferences. Pins active/default/recent/pinned
 * persistence, reasoning constrained to the selected model's surface (incl. `off`), legacy
 * provider-string compatibility, persisted-JSON decode, and the absence of any routing side effects.
 */

const ref = (sourceId: string, modelId: string, reasoning: string | null = null): ModelRef => ({
  sourceId,
  modelId,
  reasoning,
});

const surface = (levels: readonly string[], def: string) => ({ levels, default: def });

test("constrainReasoning clamps a request to the model's surface, honoring off only when offered", () => {
  const full = surface(["off", "low", "high"], "low");
  assert.equal(constrainReasoning(full, "high"), "high", "a supported level passes through");
  assert.equal(constrainReasoning(full, "off"), "off", "off is honored when the surface lists it");
  assert.equal(
    constrainReasoning(full, "ultra"),
    "low",
    "a level off the graduated ladder falls to the default",
  );
  assert.equal(constrainReasoning(full, null), "low", "no request -> the surface default");

  // A model with no reasoning surface yields null (reasoning simply does not apply).
  assert.equal(constrainReasoning(surface([], "x"), "high"), null);
});

test("constrainReasoning carries a thinking effort across a switch, never dropping it to off", () => {
  // The owner's rule: keep the chosen effort when switching models. xhigh onto a model that caps at
  // high clamps to high (the highest offered thinking level at or below it), never medium or default.
  const capHigh = surface(["off", "low", "medium", "high"], "medium");
  assert.equal(
    constrainReasoning(capHigh, "xhigh"),
    "high",
    "xhigh -> high (cap), not medium/default",
  );

  // A missing mid level clamps DOWN to the next offered thinking level, never up past the request.
  const skipsMedium = surface(["off", "low", "high", "xhigh"], "low");
  assert.equal(
    constrainReasoning(skipsMedium, "medium"),
    "low",
    "medium -> low when medium is absent",
  );

  // When every offered thinking level is ABOVE the request, take the lowest one - a thinking effort is
  // never silently turned off just because the model has no level at or below it.
  const minHigh = surface(["off", "high", "xhigh"], "high");
  assert.equal(
    constrainReasoning(minHigh, "low"),
    "high",
    "low -> high (lowest thinking level), not off",
  );

  // An explicit `off` request a model cannot honor falls to the default (off is not a thinking effort).
  const noOff = surface(["low", "high"], "high");
  assert.equal(
    constrainReasoning(noOff, "off"),
    "high",
    "off -> the surface default when unsupported",
  );

  // Binary on/off surfaces are off the ladder, so a graduated request still uses the model default.
  const binary = surface(["off", "on"], "on");
  assert.equal(constrainReasoning(binary, "high"), "on", "a binary surface is not ladder-clamped");
});

test("selectModel sets active, clamps reasoning, and fronts the deduped recent list", () => {
  const s = surface(["off", "low", "high"], "low");
  let prefs = selectModel(EMPTY_PREFERENCES, ref("qwen", "coder", "high"), s);
  assert.deepEqual(prefs.active, { sourceId: "qwen", modelId: "coder", reasoning: "high" });
  assert.deepEqual(
    prefs.recent.map(modelRefKey),
    ["qwen/coder"],
    "the selected model is recorded recent",
  );
  assert.equal(prefs.reasoningByModel["qwen/coder"], "high", "per-model reasoning is persisted");

  // Selecting a second model fronts it; re-selecting the first dedupes (no duplicate recent row).
  prefs = selectModel(prefs, ref("openai", "gpt", "low"), s);
  prefs = selectModel(prefs, ref("qwen", "coder", "off"), s);
  assert.deepEqual(
    prefs.recent.map(modelRefKey),
    ["qwen/coder", "openai/gpt"],
    "re-selecting moves to front without duplicating",
  );
  assert.equal(prefs.active?.reasoning, "off", "the re-selected reasoning is updated + clamped");
  assert.equal(prefs.reasoningByModel["qwen/coder"], "off");
});

test("selectModel clamps a carried-over reasoning the new model cannot do", () => {
  // Persisted "high" for a model whose surface only offers off/low must clamp on selection.
  const prefs = selectModel(
    EMPTY_PREFERENCES,
    ref("local", "tiny", "high"),
    surface(["off", "low"], "low"),
  );
  assert.equal(prefs.active?.reasoning, "low", "high is not supported -> default");
});

test("recent list is capped at RECENT_LIMIT, newest first", () => {
  const s = surface(["low"], "low");
  let prefs: ModelPreferences = EMPTY_PREFERENCES;
  for (let i = 0; i < RECENT_LIMIT + 3; i += 1) {
    prefs = selectModel(prefs, ref("src", `m${i}`, null), s);
  }
  assert.equal(prefs.recent.length, RECENT_LIMIT);
  assert.equal(prefs.recent[0]?.modelId, `m${RECENT_LIMIT + 2}`, "newest first");
  assert.ok(!prefs.recent.some((r) => r.modelId === "m0"), "the oldest fell off");
});

test("default + pin/unpin persist independently of recent + active", () => {
  let prefs = setDefaultModel(EMPTY_PREFERENCES, ref("qwen", "coder"));
  assert.deepEqual(prefs.default, ref("qwen", "coder"));

  prefs = pinModel(prefs, ref("openai", "gpt"));
  prefs = pinModel(prefs, ref("openai", "gpt")); // idempotent
  assert.deepEqual(prefs.pinned.map(modelRefKey), ["openai/gpt"], "pin is idempotent");

  prefs = unpinModel(prefs, { sourceId: "openai", modelId: "gpt" });
  assert.deepEqual(prefs.pinned, [], "unpin removes it");
});

test("reasoningForModel reads the persisted per-model record over the ref's own value", () => {
  const prefs = selectModel(
    EMPTY_PREFERENCES,
    ref("qwen", "coder", "high"),
    surface(["low", "high"], "low"),
  );
  assert.equal(reasoningForModel(prefs, ref("qwen", "coder", "low")), "high", "persisted wins");
  assert.equal(reasoningForModel(prefs, ref("other", "m", "low")), "low", "falls back to the ref");
  assert.equal(
    reasoningForModel(prefs, ref("none", "m")),
    null,
    "no record + no ref reasoning -> null",
  );
});

test("a legacy provider string selects through the same path", () => {
  const prefs = selectModel(
    EMPTY_PREFERENCES,
    modelRefFromProvider("qwen", "qwen3-coder", "high"),
    surface(["low", "high"], "low"),
  );
  assert.equal(prefs.active?.sourceId, "qwen", "the provider string is the source id");
  assert.equal(prefs.active?.modelId, "qwen3-coder");
  assert.equal(prefs.active?.reasoning, "high");
});

test("selectModel has no routing side effects - only active/recent/reasoning change", () => {
  const before = setDefaultModel(EMPTY_PREFERENCES, ref("d", "m"));
  const after = selectModel(before, ref("a", "b", null), surface(["low"], "low"));
  // Default + pinned are untouched; the shape carries no routing/role fields to leak into.
  assert.deepEqual(after.default, before.default);
  assert.deepEqual(after.pinned, before.pinned);
  assert.deepEqual(Object.keys(after).sort(), [
    "active",
    "default",
    "pinned",
    "reasoningByModel",
    "recent",
  ]);
});

test("quickPickerModels groups the recent models by source, newest first, never the full catalog", () => {
  const s = surface(["low"], "low");
  let prefs: ModelPreferences = EMPTY_PREFERENCES;
  // Select across two sources; recency is newest-first within the recent list.
  for (const r of [ref("qwen", "a"), ref("openai", "b"), ref("qwen", "c")]) {
    prefs = selectModel(prefs, r, s);
  }
  // recent (newest first) = [qwen/c, openai/b, qwen/a]; grouped preserving first-seen source order.
  const groups = quickPickerModels(prefs);
  assert.deepEqual(
    groups.map((g) => [g.sourceId, g.models.map((m) => m.modelId)]),
    [
      ["qwen", ["c", "a"]],
      ["openai", ["b"]],
    ],
  );
});

test("quickPickerModels stays small - bounded by the limit, empty when nothing is recent", () => {
  assert.deepEqual(quickPickerModels(EMPTY_PREFERENCES), []);
  const s = surface(["low"], "low");
  let prefs: ModelPreferences = EMPTY_PREFERENCES;
  for (let i = 0; i < 5; i += 1) {
    prefs = selectModel(prefs, ref("src", `m${i}`), s);
  }
  const total = quickPickerModels(prefs, 2).reduce((n, g) => n + g.models.length, 0);
  assert.equal(total, 2, "the popup is bounded by the limit, not the full recent list");
});

test("decodeModelPreferences drops unusable entries and re-caps recent", () => {
  const decoded = decodeModelPreferences({
    active: { sourceId: "qwen", modelId: "coder", reasoning: "high" },
    default: { sourceId: "qwen" }, // missing modelId -> dropped
    recent: [
      { sourceId: "a", modelId: "1" },
      "garbage",
      { modelId: "no-source" },
      ...Array.from({ length: 20 }, (_, i) => ({ sourceId: "s", modelId: `m${i}` })),
    ],
    pinned: [{ sourceId: "p", modelId: "1", reasoning: "low" }],
    reasoningByModel: { "a/1": "high", bad: 42 },
  });
  assert.deepEqual(decoded.active, { sourceId: "qwen", modelId: "coder", reasoning: "high" });
  assert.equal(decoded.default, null, "a ref missing a model id is dropped");
  assert.equal(decoded.recent.length, RECENT_LIMIT, "recent is re-capped on load");
  assert.equal(decoded.recent[0]?.modelId, "1", "the first valid recent entry is kept in order");
  assert.deepEqual(decoded.pinned.map(modelRefKey), ["p/1"]);
  assert.deepEqual(decoded.reasoningByModel, { "a/1": "high" }, "non-string reasoning is dropped");

  // A wholly garbage value decodes to empty, not a throw.
  assert.deepEqual(decodeModelPreferences("nope"), EMPTY_PREFERENCES);
});
