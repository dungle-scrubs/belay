import assert from "node:assert/strict";
import { test } from "vitest";
import { makeAdmissionHarness } from "../../test/support/admission-harness";
import type { AdmissionOwner } from "../admission/contract";
import { LocalResidencyClaims, type ResidencyClaimTarget } from "./claims";

/**
 * Cross-instance residency claims on plan 11's shared store (plan 11.1 M3). Two `caps` over one backing
 * fs model two instances; claims are counted (not queued), idempotent, released on switch, and a crashed
 * or wedged instance's claim expires via plan 11's TTL + stale reaping (D-007). Driven over the shared
 * admission harness - no real processes.
 */

const TARGET: ResidencyClaimTarget = {
  provider: "lmstudio",
  baseUrl: "http://localhost:1234/v1",
  model: "unsloth/qwen3.6-27b-mlx",
};
const STALE = 60_000;

function owner(id: string, pid: number): AdmissionOwner {
  return { ownerId: id, hostId: id, pid, provider: "lmstudio", model: TARGET.model };
}

test("two instances each claim the same model; both live claims are visible cross-process", async () => {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  h.spawn(100);
  h.spawn(200);
  const a = new LocalResidencyClaims(h.a, () => owner("host-a", 100), STALE);
  const b = new LocalResidencyClaims(h.b, () => owner("host-b", 200), STALE);
  await a.claim(TARGET);
  await b.claim(TARGET);
  assert.equal(a.liveClaims(TARGET), 2, "both instances' claims are counted");
  assert.equal(b.liveClaims(TARGET), 2, "and visible from the other instance");
  assert.deepEqual(
    b
      .claimants(TARGET)
      .map((o) => o.ownerId)
      .sort(),
    ["host-a", "host-b"],
  );
});

test("claim is idempotent: re-claiming heartbeats rather than double-counting", async () => {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  h.spawn(100);
  const a = new LocalResidencyClaims(h.a, () => owner("host-a", 100), STALE);
  await a.claim(TARGET);
  h.advance(1_000);
  await a.claim(TARGET); // re-claim same model -> heartbeat, not a second entry
  assert.equal(a.liveClaims(TARGET), 1, "still exactly one claim for this instance");
});

test("releasing a claim drops the reference count; the last release empties it", async () => {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  h.spawn(100);
  h.spawn(200);
  const a = new LocalResidencyClaims(h.a, () => owner("host-a", 100), STALE);
  const b = new LocalResidencyClaims(h.b, () => owner("host-b", 200), STALE);
  await a.claim(TARGET);
  await b.claim(TARGET);
  await a.release(TARGET);
  assert.equal(b.liveClaims(TARGET), 1, "one claim remains after A releases");
  await b.release(TARGET);
  assert.equal(b.liveClaims(TARGET), 0, "the last release empties the claim set (evictable)");
  // Releasing again is a harmless no-op.
  await b.release(TARGET);
  assert.equal(b.liveClaims(TARGET), 0);
});

test("a crashed instance's claim stops counting (dead pid), while a heartbeating one survives", async () => {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  h.spawn(100);
  h.spawn(200);
  const a = new LocalResidencyClaims(h.a, () => owner("host-a", 100), STALE);
  const b = new LocalResidencyClaims(h.b, () => owner("host-b", 200), STALE);
  await a.claim(TARGET);
  await b.claim(TARGET);
  assert.equal(b.liveClaims(TARGET), 2);

  h.kill(100); // instance A crashes
  assert.equal(b.liveClaims(TARGET), 1, "the dead-pid claim no longer counts");

  // B heartbeats WITHIN the TTL window (as a live instance does) across more than a full window of
  // elapsed time, so it stays live while A's crashed claim is gone.
  for (let i = 0; i < 3; i++) {
    h.advance(STALE / 2);
    await b.claim(TARGET); // heartbeat refresh
  }
  assert.equal(b.liveClaims(TARGET), 1, "the heartbeating instance's claim survives");
});

test("a claim whose heartbeat ages past the TTL is excluded even if its pid is alive (D-007)", async () => {
  const h = makeAdmissionHarness({ staleAfterMs: STALE });
  h.spawn(100); // pid stays alive the whole time
  const a = new LocalResidencyClaims(h.a, () => owner("host-a", 100), STALE);
  await a.claim(TARGET);
  assert.equal(a.liveClaims(TARGET), 1);
  h.advance(STALE + 1_000); // A stopped heartbeating (wedged); pid still alive
  assert.equal(a.liveClaims(TARGET), 0, "an aged-out claim is not live even with a live pid");
});
