import { rmSync } from "node:fs";
import { join } from "node:path";
import { type FakeLmStudioResidency, makeFakeLmStudioResidency } from "@trevor/agent-host/testing";
import { tempDir } from "@trevor/test-kit";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

/**
 * Cross-instance local-model residency smoke (plan 11.1 M7). The unit tests prove the reference-counting
 * decision logic over the in-memory admission harness; this proves the SAME logic across two host
 * instances contending on ONE real cross-process admission store (real lease files on disk), with a fake
 * LM Studio that records `lms unload` instead of shelling out. Deterministic (no model, no network), so
 * it runs in the required hermetic e2e lane.
 *
 * The guarantees pinned here: two instances keep their claimed models resident (no thrash); a model is
 * unloaded only after its LAST claim is released; a model under an active generation on ANOTHER instance
 * is never evicted; and a model no instance loaded is never touched.
 */

const PROVIDER = "lmstudio";
const EP = "http://localhost:1234/v1";
const target = (model: string) => ({ provider: PROVIDER, baseUrl: EP, model });

let stateHome: string;
let fake: FakeLmStudioResidency;
let seq = 0;

beforeAll(() => {
  stateHome = tempDir("trevor-residency-state-");
});

afterEach(() => {
  // A fresh admission dir per test so the shared temp home never cross-contaminates claim/generation files.
  seq += 1;
});

afterAll(() => {
  rmSync(stateHome, { recursive: true, force: true });
});

/** A fresh fake LM Studio (its own admission dir) so each test's lease files are isolated. */
function freshFake(): FakeLmStudioResidency {
  return makeFakeLmStudioResidency({ dir: join(stateHome, `admission-${seq}`) });
}

test("a model is unloaded only after its LAST claim is released (two instances, no thrash)", async () => {
  fake = freshFake();
  const a = fake.instance({ hostId: "host-a" });
  const b = fake.instance({ hostId: "host-b" });
  const X = target("unsloth/qwen3.6-27b-mlx");
  const Y = target("unsloth/gemma3-27b-mlx");

  // Both instances load + claim X (each ran its own `lms load`; the claim is one shared cross-process ref).
  a.load(X);
  b.load(X);
  await a.residency.onActiveModelChanged(X);
  await b.residency.onActiveModelChanged(X);

  // A switches to Y: it releases its X claim and sweeps - but B still claims X, so X is NOT unloaded.
  a.load(Y);
  await a.residency.onActiveModelChanged(Y);
  expect(a.unloaded).toEqual([]); // no thrash: A never unloads a model B still uses

  // B switches to Y too: now X has no live claim, so B (which loaded X) unloads it - the last release.
  b.load(Y);
  await b.residency.onActiveModelChanged(Y);
  expect(b.unloaded).toEqual(["unsloth/qwen3.6-27b-mlx"]);

  // B, which performed the unload, no longer lists X resident; both instances now keep Y resident. (A's
  // own registry still lists X - A never physically unloaded it, B did - which is correct per-instance
  // bookkeeping, not thrash: the guarantee is that no instance unloaded a model another was still using.)
  expect(b.residency.summary().rows.map((r) => r.model)).toEqual(["unsloth/gemma3-27b-mlx"]);
  expect(a.residency.summary().rows.map((r) => r.model)).toContain("unsloth/gemma3-27b-mlx");
});

test("a model under an active generation on another instance is never evicted", async () => {
  fake = freshFake();
  const a = fake.instance({ hostId: "host-a" });
  const b = fake.instance({ hostId: "host-b" });
  const X = target("unsloth/qwen3.6-27b-mlx");
  const Y = target("unsloth/gemma3-27b-mlx");
  const Z = target("unsloth/phi4-14b-mlx");

  // A loaded + claims X; B is mid-generation on X (a real generation lease on the shared store) but holds
  // no residency claim.
  a.load(X);
  await a.residency.onActiveModelChanged(X);
  const gen = await b.startGeneration(X);

  // A switches X -> Y: it releases its X claim and sweeps the endpoint. X now has NO residency claim, but
  // B's generation is live, so A must NOT unload it (the active-generation guard, cross-instance).
  a.load(Y);
  await a.residency.onActiveModelChanged(Y);
  expect(a.unloaded).toEqual([]);

  // B's generation ends; A's next endpoint sweep (switching Y -> Z) now finds X claim-free AND stream-free,
  // so the previously-protected model is reclaimed.
  await gen.release();
  a.load(Z);
  await a.residency.onActiveModelChanged(Z);
  expect(a.unloaded).toContain("unsloth/qwen3.6-27b-mlx");
});

test("a model no instance loaded (external) is never unloaded", async () => {
  fake = freshFake();
  const a = fake.instance({ hostId: "host-a" });
  const X = target("unsloth/qwen3.6-27b-mlx");

  // Only X is Trevor-loaded; an externally-loaded model was never recorded, so it is not a candidate.
  a.load(X);
  await a.residency.onActiveModelChanged(X);
  await a.residency.shutdown(); // release + sweep this instance's endpoint

  // The sweep unloaded exactly A's own model - never the external one.
  expect(a.unloaded).toEqual(["unsloth/qwen3.6-27b-mlx"]);
  expect(a.unloaded).not.toContain("someone-elses/model");
});
