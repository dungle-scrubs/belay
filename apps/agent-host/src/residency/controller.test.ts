import assert from "node:assert/strict";
import { test } from "vitest";
import { makeAdmissionHarness } from "../../test/support/admission-harness";
import type { AdmissionOwner } from "../admission/contract";
import { LocalResidencyClaims, type ResidencyClaimTarget } from "./claims";
import { KeepCurrentResidency } from "./controller";
import { type EvictionDeps, LocalResidencyEviction } from "./eviction";
import { LocalResidencyRegistry } from "./registry";

/**
 * The keep-only-current (cap 1) residency policy (plan 11.1 M5): one instance keeps exactly its active
 * local model resident, releases the prior on switch, and the switch evicts the prior model only when it
 * was the last claim (reference-counted). Two instances on different models do not thrash each other.
 */

const PROVIDER = "lmstudio";
const EP = "http://localhost:1234/v1";
const X = "unsloth/qwen3.6-27b-mlx";
const Y = "unsloth/gemma3-27b-mlx";
const STALE = 60_000;

const target = (model: string): ResidencyClaimTarget => ({
  provider: PROVIDER,
  baseUrl: EP,
  model,
});

function owner(id: string, pid: number): AdmissionOwner {
  return { ownerId: id, hostId: id, pid, provider: PROVIDER, model: "" };
}

function instance(caps: ReturnType<typeof makeAdmissionHarness>["a"], id: string, pid: number) {
  const registry = new LocalResidencyRegistry();
  const claims = new LocalResidencyClaims(caps, () => owner(id, pid), STALE);
  const unloaded: string[] = [];
  const deps: EvictionDeps = {
    registry,
    claims,
    caps,
    withLifecycleLease: async (_t, fn) => {
      await fn();
    },
    unload: async (m) => {
      unloaded.push(m);
    },
    staleAfterMs: STALE,
  };
  const eviction = new LocalResidencyEviction(deps);
  const controller = new KeepCurrentResidency(claims, eviction);
  return { registry, claims, eviction, controller, unloaded };
}

test("switching the active model releases the prior claim and evicts the now-orphaned prior model", async () => {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  h.spawn(100);
  const self = instance(h.a, "host-a", 100);

  // Load + claim model X.
  self.registry.recordLoad(PROVIDER, EP, X, 65_536);
  await self.controller.onActiveModelChanged(target(X));
  assert.equal(self.claims.liveClaims(target(X)), 1, "X is claimed");

  // Load Y, then switch active model X -> Y.
  self.registry.recordLoad(PROVIDER, EP, Y, 65_536);
  await self.controller.onActiveModelChanged(target(Y));

  assert.equal(self.claims.liveClaims(target(Y)), 1, "Y is now claimed (cap 1)");
  assert.equal(self.claims.liveClaims(target(X)), 0, "the prior claim on X was released");
  assert.deepEqual(self.unloaded, [X], "X, now orphaned, was evicted on the switch");
  assert.equal(self.registry.isTrevorLoaded(EP, Y), true, "Y stays resident");
});

test("a model another instance still uses is NOT evicted when this instance switches away (no thrash)", async () => {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  h.spawn(100);
  h.spawn(200);
  const a = instance(h.a, "host-a", 100);
  const b = instance(h.b, "host-b", 200);

  // Both instances are on X (shared model); each records it resident locally.
  a.registry.recordLoad(PROVIDER, EP, X, 65_536);
  b.registry.recordLoad(PROVIDER, EP, X, 65_536);
  await a.controller.onActiveModelChanged(target(X));
  await b.controller.onActiveModelChanged(target(X));
  assert.equal(a.claims.liveClaims(target(X)), 2, "both instances claim X");

  // A switches away to Y; B still wants X.
  a.registry.recordLoad(PROVIDER, EP, Y, 65_536);
  await a.controller.onActiveModelChanged(target(Y));

  assert.deepEqual(a.unloaded, [], "A does not evict X - B still claims it");
  assert.equal(a.claims.liveClaims(target(X)), 1, "B's claim on X survives A's switch");
  assert.equal(a.claims.liveClaims(target(Y)), 1, "A now claims Y");
});

test("re-selecting the same model just heartbeats the existing claim (no release, no evict)", async () => {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  h.spawn(100);
  const self = instance(h.a, "host-a", 100);
  self.registry.recordLoad(PROVIDER, EP, X, 65_536);
  await self.controller.onActiveModelChanged(target(X));

  h.advance(1_000);
  await self.controller.onActiveModelChanged(target(X)); // same model again

  assert.equal(self.claims.liveClaims(target(X)), 1, "still exactly one claim");
  assert.deepEqual(self.unloaded, [], "no eviction for a same-model reselect");
});

test("shutdown releases the current claim and evicts the model if it was the last user", async () => {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  h.spawn(100);
  const self = instance(h.a, "host-a", 100);
  self.registry.recordLoad(PROVIDER, EP, X, 65_536);
  await self.controller.onActiveModelChanged(target(X));

  await self.controller.shutdown();

  assert.equal(self.claims.liveClaims(target(X)), 0, "the claim was released on shutdown");
  assert.deepEqual(self.unloaded, [X], "the orphaned model was evicted on a clean stop");
});

test("heartbeat keeps the current claim alive across more than a full TTL window", async () => {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  h.spawn(100);
  const self = instance(h.a, "host-a", 100);
  self.registry.recordLoad(PROVIDER, EP, X, 65_536);
  await self.controller.onActiveModelChanged(target(X));

  for (let i = 0; i < 3; i++) {
    h.advance(STALE / 2);
    await self.controller.heartbeat();
  }
  assert.equal(self.claims.liveClaims(target(X)), 1, "the heartbeated claim never ages out");
});
