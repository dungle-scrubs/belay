import assert from "node:assert/strict";
import { test } from "vitest";
import { makeAdmissionHarness as caps } from "../../test/support/admission-harness";
import { generationResourceKey, lifecycleResourceKey } from "./contract";
import { createLocalAdmissionGate, type LocalAdmissionContext } from "./service";
import { type AdmissionCaps, inspectResource } from "./store";

/**
 * The host-facing admission gate (plan 11 M5/M6): generation admission serializes streams per model,
 * lifecycle admission serializes reloads per endpoint, capacity + priority come from the injected
 * config/context. Driven over the same in-memory fs harness as the store.
 */

const TARGET = {
  provider: "lmstudio",
  baseUrl: "http://localhost:1234/v1",
  model: "qwen3.6-27b-mlx",
};

let ownerSeq = 0;
function gate(
  c: AdmissionCaps,
  resolveContext?: () => LocalAdmissionContext,
  capacityFor?: (k: string) => number,
) {
  return createLocalAdmissionGate({
    hostId: "host-test",
    newOwnerId: () => `owner-${++ownerSeq}`,
    caps: c,
    pid: 4242,
    resolveContext,
    capacityFor,
  });
}

test("two generation acquires for the same model serialize: the first holds, the second queues", async () => {
  const h = caps();
  h.spawn(4242);
  const g = gate(h.caps);

  const first = await g.acquireGeneration(TARGET);
  assert.equal(first.held, true);

  // The second acquire for the same model with an already-aborted signal cannot wait, so it returns a
  // no-op handle but leaves the queue entry removed - proving it was blocked (not granted).
  const controller = new AbortController();
  controller.abort();
  const second = await g.acquireGeneration(TARGET, { signal: controller.signal });
  assert.equal(
    second.held,
    false,
    "the second generation is blocked while the first holds the slot",
  );

  const view = inspectResource(
    generationResourceKey(TARGET.provider, TARGET.baseUrl, TARGET.model),
    h.caps,
  );
  assert.equal(view.active.length, 1, "exactly one active generation");
  assert.equal(view.queue.length, 0, "the cancelled second left no queue residue");

  await first.release("success");
});

test("a different model on the same endpoint is an independent generation resource", async () => {
  const h = caps();
  h.spawn(4242);
  const g = gate(h.caps);
  const a = await g.acquireGeneration(TARGET);
  const b = await g.acquireGeneration({ ...TARGET, model: "llama-3.3" });
  // Both hold concurrently: different model => different resource.
  assert.equal(a.held, true);
  assert.equal(b.held, true);
  await a.release("success");
  await b.release("success");
});

test("withLifecycle serializes a reload under the endpoint lifecycle lease and releases after", async () => {
  const h = caps();
  h.spawn(4242);
  const g = gate(h.caps);
  const key = lifecycleResourceKey(TARGET.provider, TARGET.baseUrl);

  let ranInside = false;
  const result = await g.withLifecycle(TARGET, async () => {
    // While the lifecycle op runs, the lease is held.
    assert.equal(
      inspectResource(key, h.caps).active.length,
      1,
      "the lifecycle lease is held during fn",
    );
    ranInside = true;
    return "reloaded";
  });
  assert.equal(result, "reloaded");
  assert.equal(ranInside, true);
  assert.equal(
    inspectResource(key, h.caps).active.length,
    0,
    "the lifecycle lease is released after fn",
  );
});

test("capacity + priority come from the injected config/context", async () => {
  const h = caps();
  for (const pid of [4242]) {
    h.spawn(pid);
  }
  // Capacity 2 for the generation resource; background priority from context.
  const g = gate(
    h.caps,
    () => ({ priority: "background", sessionId: "s1", runId: "r1", agentId: "child-1" }),
    () => 2,
  );
  const a = await g.acquireGeneration(TARGET);
  const b = await g.acquireGeneration(TARGET);
  assert.equal(a.held, true);
  assert.equal(b.held, true, "capacity 2 admits both");

  const view = inspectResource(
    generationResourceKey(TARGET.provider, TARGET.baseUrl, TARGET.model),
    h.caps,
  );
  assert.equal(view.capacity, 2);
  assert.equal(view.active[0]?.priority, "background", "priority comes from the resolved context");
  assert.equal(
    view.active[0]?.owner.agentId,
    "child-1",
    "owner attribution comes from the context",
  );
  await a.release("success");
  await b.release("success");
});
