import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ADMISSION_PRIORITIES,
  type AdmissionPriority,
  generationResourceKey,
  isResidencyResourceKey,
  lifecycleResourceKey,
  normalizeBaseUrl,
  priorityRank,
  residencyResourceKey,
  resourceKeyHash,
} from "./contract";

/**
 * The local-admission contract (plan 11 M1/M2): resource keys derived from the concrete local target,
 * the lifecycle vs generation split, base-URL normalization (so trailing-slash variants key alike),
 * and the priority ordering (foreground first, FIFO within a class). These pin the V1-provenance keying
 * and the V2 cross-process priority contract.
 */

test("generation keys are per provider/baseUrl/model; the lifecycle key is per endpoint", () => {
  const gen = generationResourceKey("lmstudio", "http://localhost:1234/v1", "qwen3.6-27b-mlx");
  assert.equal(gen, "local-provider:lmstudio:http://localhost:1234/v1:qwen3.6-27b-mlx");

  const life = lifecycleResourceKey("lmstudio", "http://localhost:1234/v1");
  assert.equal(life, "local-provider-lifecycle:lmstudio:http://localhost:1234/v1");

  // Two models on the same endpoint are DIFFERENT generation resources but the SAME lifecycle resource.
  const other = generationResourceKey("lmstudio", "http://localhost:1234/v1", "llama-3.3");
  assert.notEqual(gen, other);
  assert.equal(
    lifecycleResourceKey("lmstudio", "http://localhost:1234/v1"),
    lifecycleResourceKey("lmstudio", "http://localhost:1234/v1"),
  );
});

test("residency keys are distinct from generation/lifecycle and identified by isResidencyResourceKey", () => {
  const res = residencyResourceKey("lmstudio", "http://localhost:1234/v1", "qwen3.6-27b-mlx");
  assert.equal(res, "local-residency:lmstudio:http://localhost:1234/v1:qwen3.6-27b-mlx");
  // The predicate distinguishes a residency claim from the admission leases sharing the store, so the
  // admission /doctor summary can exclude residency claims (plan 11.1) - no double-count.
  assert.equal(isResidencyResourceKey(res), true);
  assert.equal(
    isResidencyResourceKey(generationResourceKey("lmstudio", "http://localhost:1234/v1", "m")),
    false,
    "a generation lease is not a residency claim",
  );
  assert.equal(
    isResidencyResourceKey(lifecycleResourceKey("lmstudio", "http://localhost:1234/v1")),
    false,
    "a lifecycle lease is not a residency claim",
  );
});

test("base URL normalization collapses trailing slashes + whitespace so variants key identically", () => {
  assert.equal(normalizeBaseUrl("http://localhost:1234/v1/"), "http://localhost:1234/v1");
  assert.equal(normalizeBaseUrl("  http://localhost:1234/v1//  "), "http://localhost:1234/v1");
  assert.equal(
    generationResourceKey("lmstudio", "http://localhost:1234/v1/", "m"),
    generationResourceKey("lmstudio", "http://localhost:1234/v1", "m"),
  );
});

test("resourceKeyHash is stable, filesystem-safe, and distinguishes different keys", () => {
  const a = resourceKeyHash(generationResourceKey("lmstudio", "http://x:1234/v1", "m1"));
  const b = resourceKeyHash(generationResourceKey("lmstudio", "http://x:1234/v1", "m2"));
  assert.match(a, /^[a-z0-9]+$/i, "hash is filesystem-safe");
  assert.equal(a, resourceKeyHash(generationResourceKey("lmstudio", "http://x:1234/v1", "m1")));
  assert.notEqual(a, b);
});

test("priority order is foreground -> recovery -> command -> background -> maintenance (FIFO within)", () => {
  assert.deepEqual(ADMISSION_PRIORITIES, [
    "foreground",
    "recovery",
    "command",
    "background",
    "maintenance",
  ]);
  const sorted = [...ADMISSION_PRIORITIES].sort((x, y) => priorityRank(x) - priorityRank(y));
  assert.deepEqual(sorted, ADMISSION_PRIORITIES, "rank reflects the declared order");
  assert.ok(priorityRank("foreground") < priorityRank("background"), "foreground beats background");
  // An unknown value sorts after every known class.
  assert.ok(priorityRank("nonsense" as AdmissionPriority) > priorityRank("maintenance"));
});
