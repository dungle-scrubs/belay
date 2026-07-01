import assert from "node:assert/strict";
import { test } from "vitest";
import { redactSecrets } from "../providers/failure-taxonomy";
import { residencyDoctorSummary } from "./doctor";
import type { LastEviction } from "./eviction";
import type { ResidentModel } from "./registry";

/**
 * The /doctor residency projection (plan 11.1 M6): resident Trevor-loaded models, their context caps and
 * live claim counts, and the last eviction. Pure read model; every surfaced field is bounded + secret-free.
 */

const EP = "http://localhost:1234/v1";
const QWEN = "unsloth/qwen3.6-27b-mlx";

function resident(model: string, contextLength: number, loadedAt: string): ResidentModel {
  return { provider: "lmstudio", endpoint: EP, model, contextLength, loadedAt };
}

test("an empty resident set is an idle residency summary", () => {
  const s = residencyDoctorSummary([], () => 0, null);
  assert.deepEqual(s, { residentModels: 0, rows: [], lastEviction: null });
});

test("summary carries each resident model's context cap and live claim count", () => {
  const models = [
    resident("unsloth/qwen3.6-27b-mlx", 65_536, "2026-06-30T10:00:00.000Z"),
    resident("unsloth/gemma3-27b-mlx", 32_768, "2026-06-30T10:05:00.000Z"),
  ];
  const claims = new Map([
    ["unsloth/qwen3.6-27b-mlx", 2],
    ["unsloth/gemma3-27b-mlx", 1],
  ]);
  const s = residencyDoctorSummary(models, (m) => claims.get(m.model) ?? 0, null);

  assert.equal(s.residentModels, 2);
  assert.deepEqual(s.rows, [
    { endpoint: EP, model: "unsloth/qwen3.6-27b-mlx", contextLength: 65_536, claims: 2 },
    { endpoint: EP, model: "unsloth/gemma3-27b-mlx", contextLength: 32_768, claims: 1 },
  ]);
});

test("the last eviction is surfaced when this instance has unloaded a model", () => {
  const last: LastEviction = {
    endpoint: EP,
    model: "unsloth/qwen3.6-27b-mlx",
    at: "2026-06-30T11:00:00.000Z",
  };
  const s = residencyDoctorSummary([], () => 0, last);
  assert.deepEqual(s.lastEviction, last);
});

test("residency facts expose no secrets: the summary is redaction-stable", () => {
  // A model id / endpoint are diagnosis handles, not credentials. Prove nothing in the surfaced summary
  // is altered by secret redaction (i.e. it contains no api-key / bearer-token shaped substrings).
  const models = [resident(QWEN, 65_536, "2026-06-30T10:00:00.000Z")];
  const last: LastEviction = { endpoint: EP, model: QWEN, at: "2026-06-30T11:00:00.000Z" };
  const s = residencyDoctorSummary(models, () => 1, last);

  const serialized = JSON.stringify(s);
  assert.equal(
    redactSecrets(serialized),
    serialized,
    "no field is redacted (nothing secret-shaped)",
  );
  // And the row shape is exactly the bounded key set - no owner pid, host id, or auth leaks in.
  const [row] = s.rows;
  assert.ok(row);
  assert.deepEqual(Object.keys(row).sort(), ["claims", "contextLength", "endpoint", "model"]);
});
