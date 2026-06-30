import assert from "node:assert/strict";
import { test } from "vitest";
import {
  lmStudioIsVision,
  lmStudioSupportsTools,
  parseLmStudioModel,
  parseLmStudioModelList,
} from "./lmstudio-native";

/**
 * The shared `/api/v0` native-record parser (M1 REFACTOR / D-001). Pins the tolerant field-by-field
 * decode (snake_case wire -> camelCase record), the list-envelope decode, and the two pure
 * derivations both the catalog and the LM Studio client read off the record.
 */

test("parseLmStudioModel maps the native fields and renames the context keys", () => {
  const record = parseLmStudioModel({
    id: "unsloth/qwen3.6-27b-mlx",
    object: "model",
    type: "llm",
    arch: "qwen3",
    quantization: "8bit",
    state: "loaded",
    max_context_length: 262144,
    loaded_context_length: 262144,
    capabilities: ["tool_use"],
  });
  assert.deepEqual(record, {
    id: "unsloth/qwen3.6-27b-mlx",
    type: "llm",
    arch: "qwen3",
    quantization: "8bit",
    state: "loaded",
    maxContextLength: 262144,
    loadedContextLength: 262144,
    capabilities: ["tool_use"],
  });
});

test("parseLmStudioModel keeps an id-only record and drops garbled fields, never throwing", () => {
  // A drifted shape (numeric type, string context, non-array capabilities) degrades field-by-field
  // to the id-only record instead of throwing.
  const record = parseLmStudioModel({
    id: "qwen/qwen3-vl-8b",
    type: 5,
    max_context_length: "lots",
    quantization: "",
    capabilities: "tool_use",
  });
  assert.deepEqual(record, { id: "qwen/qwen3-vl-8b" });

  // A non-object input is the only case that yields null.
  assert.equal(parseLmStudioModel(null), null);
  assert.equal(parseLmStudioModel("nope"), null);
  // An object with no id still parses (id defaults to "" so the list filter can drop it).
  assert.equal(parseLmStudioModel({ type: "llm" })?.id, "");
});

test("parseLmStudioModelList decodes the {data:[...]} envelope and drops id-less entries", () => {
  const records = parseLmStudioModelList({
    object: "list",
    data: [
      { id: "unsloth/qwen3.6-27b-mlx", quantization: "8bit" },
      { type: "llm" }, // no id -> dropped
      { id: "qwen/qwen3-vl-8b", type: "vlm" },
    ],
  });
  assert.deepEqual(
    records.map((r) => r.id),
    ["unsloth/qwen3.6-27b-mlx", "qwen/qwen3-vl-8b"],
  );

  // A non-list / garbled payload yields an empty array, never a throw.
  assert.deepEqual(parseLmStudioModelList({}), []);
  assert.deepEqual(parseLmStudioModelList(null), []);
  assert.deepEqual(parseLmStudioModelList({ data: "x" }), []);
});

test("lmStudioIsVision/lmStudioSupportsTools read the native vlm + tool_use signals", () => {
  assert.equal(lmStudioIsVision({ id: "m", type: "vlm" }), true);
  assert.equal(lmStudioIsVision({ id: "m", type: "llm" }), false);
  assert.equal(lmStudioIsVision({ id: "m" }), false);

  assert.equal(lmStudioSupportsTools({ id: "m", capabilities: ["tool_use"] }), true);
  assert.equal(lmStudioSupportsTools({ id: "m", capabilities: [] }), false);
  assert.equal(lmStudioSupportsTools({ id: "m" }), false);
});
