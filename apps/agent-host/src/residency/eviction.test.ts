import assert from "node:assert/strict";
import { test } from "vitest";
import { makeAdmissionHarness } from "../../test/support/admission-harness";
import { type AdmissionOwner, generationResourceKey, NO_ESTIMATE } from "../admission/contract";
import { type AdmissionCaps, acquireAdmission } from "../admission/store";
import { LocalResidencyClaims } from "./claims";
import { type EvictionDeps, LocalResidencyEviction } from "./eviction";
import { LocalResidencyRegistry } from "./registry";

/**
 * Reference-counted eviction (plan 11.1 M4): a Belay-loaded model is unloaded (under the lifecycle
 * lease) ONLY when orphaned - no live claim and no active generation - and only if Belay loaded it.
 */

const EP = "http://localhost:1234/v1";
const PROVIDER = "lmstudio";
const MODEL = "unsloth/qwen3.6-27b-mlx";
const TARGET = { provider: PROVIDER, baseUrl: EP, model: MODEL };
const STALE = 60_000;

function owner(id: string, pid: number, model = MODEL): AdmissionOwner {
  return { ownerId: id, hostId: id, pid, provider: PROVIDER, model };
}

function setup() {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  const registry = new LocalResidencyRegistry();
  const claims = new LocalResidencyClaims(h.a, () => owner("host-self", 100), STALE);
  const unloaded: string[] = [];
  const leaseCalls: string[] = [];
  const deps: EvictionDeps = {
    registry,
    claims,
    caps: h.a,
    withLifecycleLease: async (t, fn) => {
      leaseCalls.push(t.model);
      await fn();
    },
    unload: async (m) => {
      unloaded.push(m);
    },
    staleAfterMs: STALE,
  };
  const eviction = new LocalResidencyEviction(deps);
  return { h, registry, claims, eviction, unloaded, leaseCalls };
}

function startGeneration(caps: AdmissionCaps, o: AdmissionOwner, model = MODEL) {
  return acquireAdmission(
    {
      key: generationResourceKey(PROVIDER, EP, model),
      owner: o,
      priority: "foreground",
      estimate: NO_ESTIMATE,
      capacity: 1,
    },
    caps,
  );
}

test("an orphaned Belay-loaded model (no claim, no generation) is unloaded under the lifecycle lease", async () => {
  const { h, registry, eviction, unloaded, leaseCalls } = setup();
  h.spawn(100);
  registry.recordLoad(PROVIDER, EP, MODEL, 65_536);

  const outcomes = await eviction.sweep(PROVIDER, EP);
  assert.deepEqual(outcomes, [{ model: MODEL, unloaded: true }]);
  assert.deepEqual(unloaded, [MODEL], "the model was unloaded");
  assert.deepEqual(leaseCalls, [MODEL], "the unload ran under the lifecycle lease");
  assert.equal(registry.isTrevorLoaded(EP, MODEL), false, "and recorded as no longer resident");
});

test("a model another live instance still claims is NOT unloaded (D-002)", async () => {
  const { h, registry, eviction, unloaded } = setup();
  h.spawn(100);
  h.spawn(200);
  registry.recordLoad(PROVIDER, EP, MODEL, 65_536);
  // Instance B (a different live instance) claims the model; this instance switched away.
  const b = new LocalResidencyClaims(h.b, () => owner("host-b", 200), STALE);
  await b.claim(TARGET);

  const outcomes = await eviction.sweep(PROVIDER, EP);
  assert.deepEqual(outcomes, [{ model: MODEL, unloaded: false, skipped: "other-claim" }]);
  assert.deepEqual(unloaded, [], "a model another instance claims is never unloaded");
  assert.equal(registry.isTrevorLoaded(EP, MODEL), true, "it stays resident");
});

test("a model under an active generation is NOT unloaded (cross-instance: A generating, B switching away)", async () => {
  const { h, registry, eviction, unloaded } = setup();
  h.spawn(100);
  h.spawn(300);
  registry.recordLoad(PROVIDER, EP, MODEL, 65_536);
  // Instance A is mid-generation on the model (holds its generation resource); no residency claim.
  await startGeneration(h.b, owner("gen-a", 300));

  const outcomes = await eviction.sweep(PROVIDER, EP);
  assert.deepEqual(outcomes, [{ model: MODEL, unloaded: false, skipped: "active-generation" }]);
  assert.deepEqual(unloaded, [], "a model being generated on is never unloaded");
});

test("only Belay-loaded models are candidates; an externally-loaded model is never touched (D-004)", async () => {
  const { h, registry, eviction, unloaded } = setup();
  h.spawn(100);
  registry.recordLoad(PROVIDER, EP, "belay-loaded-model", 65_536);
  // "external-model" is NOT recorded (loaded outside Belay) -> never a candidate.

  const outcomes = await eviction.sweep(PROVIDER, EP);
  assert.deepEqual(
    outcomes.map((o) => o.model),
    ["belay-loaded-model"],
    "only Belay-loaded models are swept",
  );
  assert.deepEqual(
    unloaded,
    ["belay-loaded-model"],
    "the external model is never in the unload set",
  );
});

test("a model resident on a DIFFERENT endpoint is not swept for this endpoint", async () => {
  const { h, registry, eviction, unloaded } = setup();
  h.spawn(100);
  registry.recordLoad(PROVIDER, "http://other:1234/v1", MODEL, 65_536);

  const outcomes = await eviction.sweep(PROVIDER, EP);
  assert.deepEqual(outcomes, [], "nothing on this endpoint to sweep");
  assert.deepEqual(unloaded, []);
});
