import assert from "node:assert/strict";
import { test } from "vitest";
import { makeAdmissionHarness } from "../../test/support/admission-harness";
import { createHostResidency } from "./host";

/**
 * The host residency composition (plan 11.1): wires registry + claims + eviction + keep-current policy
 * into the one object the host drives, and the /doctor summary it projects. Driven over the shared
 * admission harness (no real store, no real `lms`).
 */

const PROVIDER = "lmstudio";
const EP = "http://localhost:1234/v1";
const X = "unsloth/qwen3.6-27b-mlx";
const Y = "unsloth/gemma3-27b-mlx";
const STALE = 60_000;

const target = (model: string) => ({ provider: PROVIDER, baseUrl: EP, model });

function setup() {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  h.spawn(100);
  const unloaded: string[] = [];
  const residency = createHostResidency({
    caps: h.a,
    hostId: "host-a",
    pid: 100,
    withLifecycleLease: async (_t, fn) => {
      await fn();
    },
    unload: async (m) => {
      unloaded.push(m);
    },
    staleAfterMs: STALE,
  });
  return { h, residency, unloaded };
}

test("a recorded load shows up as a resident model in the /doctor summary with its claim count", async () => {
  const { residency } = setup();
  residency.recorder.recordLoad(PROVIDER, EP, X, 65_536);
  await residency.onActiveModelChanged(target(X));

  const summary = residency.summary();
  assert.equal(summary.residentModels, 1);
  assert.deepEqual(summary.rows, [{ endpoint: EP, model: X, contextLength: 65_536, claims: 1 }]);
  assert.equal(summary.lastEviction, null);
});

test("switching the active local model evicts the orphaned prior model and records it in the summary", async () => {
  const { residency, unloaded } = setup();
  residency.recorder.recordLoad(PROVIDER, EP, X, 65_536);
  await residency.onActiveModelChanged(target(X));

  residency.recorder.recordLoad(PROVIDER, EP, Y, 65_536);
  await residency.onActiveModelChanged(target(Y));

  assert.deepEqual(unloaded, [X], "the prior model was unloaded on the switch");
  const summary = residency.summary();
  assert.deepEqual(
    summary.rows.map((r) => r.model),
    [Y],
    "only the current model remains resident",
  );
  assert.equal(summary.lastEviction?.model, X, "the last eviction is surfaced");
});

test("a cloud turn (null target) releases the local claim and sweeps it", async () => {
  const { residency, unloaded } = setup();
  residency.recorder.recordLoad(PROVIDER, EP, X, 65_536);
  await residency.onActiveModelChanged(target(X));

  await residency.onActiveModelChanged(null); // resolved a cloud provider

  assert.deepEqual(unloaded, [X], "the local model is released + evicted when the turn goes cloud");
  assert.equal(residency.summary().residentModels, 0);
});

test("shutdown releases the current claim and sweeps", async () => {
  const { residency, unloaded } = setup();
  residency.recorder.recordLoad(PROVIDER, EP, X, 65_536);
  await residency.onActiveModelChanged(target(X));

  await residency.shutdown();
  assert.deepEqual(unloaded, [X]);
});
