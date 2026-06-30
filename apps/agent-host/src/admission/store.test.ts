import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ADMISSION_TEST_DIR,
  makeAdmissionHarness as harness,
} from "../../test/support/admission-harness";
import type { AdmissionEstimate, AdmissionOwner, AdmissionPriority } from "./contract";
import { generationResourceKey } from "./contract";
import {
  ADMISSION_STALE_MS,
  type AdmissionCaps,
  type AdmissionFs,
  AdmissionStoreUnavailable,
  acquireAdmission,
  heartbeatAdmission,
  inspectResource,
  pollAdmission,
  releaseAdmission,
  snapshotAdmission,
} from "./store";

/**
 * The shared cross-process admission lease + queue store (plan 11 M3/M4). Driven hermetically over an
 * in-memory fs + a fake clock + a controllable pid-liveness set, so capacity enforcement, queueing,
 * priority/FIFO ordering, heartbeat-vs-stale reaping, cancellation, and the token-budget refusals are
 * pinned without real processes or files. Two `caps` over the SAME backing fs model two independent
 * host processes contending for one resource.
 */

const KEY = generationResourceKey("lmstudio", "http://localhost:1234/v1", "qwen3.6-27b-mlx");
const NO_BUDGET: AdmissionEstimate = {
  estimatedTokens: 0,
  maxOutputTokens: 0,
  contextWindowTokens: 0,
};

function owner(ownerId: string, pid: number): AdmissionOwner {
  return { ownerId, hostId: `host-${pid}`, pid, provider: "lmstudio", model: "qwen3.6-27b-mlx" };
}

function req(
  ownerId: string,
  pid: number,
  priority: AdmissionPriority = "foreground",
  over: Partial<{ estimate: AdmissionEstimate; capacity: number }> = {},
) {
  return {
    key: KEY,
    owner: owner(ownerId, pid),
    priority,
    estimate: over.estimate ?? NO_BUDGET,
    capacity: over.capacity,
  };
}

// --- M3: capacity, atomic leases, stale reaping, heartbeat ---

test("two processes cannot both hold a capacity-1 resource: one acquires, the other queues", async () => {
  const h = harness();
  h.spawn(100);
  h.spawn(200);

  const first = await acquireAdmission(req("a1", 100), h.a);
  const second = await acquireAdmission(req("b1", 200), h.b);

  assert.deepEqual(first, { status: "acquired" });
  assert.deepEqual(
    second,
    { status: "queued", position: 0 },
    "the 2nd contender queues at the front",
  );

  // The shared file shows exactly one active holder and one queued waiter, visible to BOTH processes.
  const view = inspectResource(KEY, h.b);
  assert.equal(view.active.length, 1);
  assert.equal(view.active[0]?.owner.ownerId, "a1");
  assert.equal(view.queue.length, 1);
  assert.equal(view.queue[0]?.owner.ownerId, "b1");
});

test("releasing the active holder drains the queued waiter into the free slot", async () => {
  const h = harness();
  h.spawn(100);
  h.spawn(200);
  await acquireAdmission(req("a1", 100), h.a);
  await acquireAdmission(req("b1", 200), h.b);

  // While a1 holds, b1 keeps waiting.
  assert.deepEqual(await pollAdmission(KEY, "b1", h.b), { status: "queued", position: 0 });

  await releaseAdmission(KEY, "a1", h.a);
  // After release b1's next poll promotes it into the freed slot.
  assert.deepEqual(await pollAdmission(KEY, "b1", h.b), { status: "acquired" });
  const view = inspectResource(KEY, h.a);
  assert.equal(view.active[0]?.owner.ownerId, "b1");
  assert.equal(view.queue.length, 0);
});

test("a capacity raise lets two holders in; the third queues", async () => {
  const h = harness();
  for (const pid of [100, 200, 300]) {
    h.spawn(pid);
  }
  assert.deepEqual(await acquireAdmission(req("a", 100, "foreground", { capacity: 2 }), h.a), {
    status: "acquired",
  });
  assert.deepEqual(await acquireAdmission(req("b", 200, "foreground", { capacity: 2 }), h.b), {
    status: "acquired",
  });
  assert.deepEqual(await acquireAdmission(req("c", 300, "foreground", { capacity: 2 }), h.a), {
    status: "queued",
    position: 0,
  });
});

test("a dead active owner is reaped, freeing the slot for a waiter (cross-process crash recovery)", async () => {
  const h = harness();
  h.spawn(100);
  h.spawn(200);
  await acquireAdmission(req("a1", 100), h.a);
  await acquireAdmission(req("b1", 200), h.b);

  // Process A crashes (pid 100 dies). b1's next poll reaps the dead holder and takes the slot.
  h.kill(100);
  assert.deepEqual(await pollAdmission(KEY, "b1", h.b), { status: "acquired" });
});

test("an active owner whose heartbeat ages past the window is reaped even if its pid looks alive", async () => {
  const h = harness();
  h.spawn(100);
  h.spawn(200);
  await acquireAdmission(req("a1", 100), h.a);
  await acquireAdmission(req("b1", 200), h.b);

  // a1 stops heartbeating; once the heartbeat ages past the stale window, b1 reclaims even though pid
  // 100 still appears alive (pid reuse / wedged owner).
  h.advance(ADMISSION_STALE_MS + 1_000);
  assert.deepEqual(await pollAdmission(KEY, "b1", h.b), { status: "acquired" });
});

test("heartbeating an active holder keeps it from being reaped under contention", async () => {
  const h = harness();
  h.spawn(100);
  h.spawn(200);
  await acquireAdmission(req("a1", 100), h.a);
  await acquireAdmission(req("b1", 200), h.b);

  // a1 keeps heartbeating across more than a stale window of elapsed time; b1 never gets in.
  for (let i = 0; i < 5; i++) {
    h.advance(ADMISSION_STALE_MS / 2);
    assert.deepEqual(await heartbeatAdmission(KEY, "a1", h.a), { refreshed: true });
    assert.deepEqual(await pollAdmission(KEY, "b1", h.b), { status: "queued", position: 0 });
  }
  // Heartbeating an owner that is gone reports not-refreshed.
  assert.deepEqual(await heartbeatAdmission(KEY, "ghost", h.a), { refreshed: false });
});

// --- M4: queue, priority, cancellation, refusals ---

test("queued work drains in priority order, FIFO within a class", async () => {
  const h = harness();
  for (const pid of [1, 2, 3, 4, 5]) {
    h.spawn(pid);
  }
  // hold the single slot with a maintenance owner so everything else queues.
  await acquireAdmission(req("hold", 1, "maintenance"), h.a);
  // Enqueue out of priority order: background, foreground#1, foreground#2, command.
  await acquireAdmission(req("bg", 2, "background"), h.a);
  h.advance(10);
  await acquireAdmission(req("fg1", 3, "foreground"), h.a);
  h.advance(10);
  await acquireAdmission(req("fg2", 4, "foreground"), h.a);
  h.advance(10);
  await acquireAdmission(req("cmd", 5, "command"), h.a);

  // Queue order: foreground (FIFO fg1 before fg2), then command, then background.
  const view = inspectResource(KEY, h.a);
  assert.deepEqual(
    view.queue.map((r) => r.owner.ownerId),
    ["fg1", "fg2", "cmd", "bg"],
  );

  // Drain one at a time and confirm the order holds across releases.
  const drained: string[] = [];
  await releaseAdmission(KEY, "hold", h.a);
  for (const id of ["fg1", "fg2", "cmd", "bg"]) {
    assert.deepEqual(await pollAdmission(KEY, id, h.a), { status: "acquired" }, `${id} promoted`);
    drained.push(id);
    await releaseAdmission(KEY, id, h.a);
  }
  assert.deepEqual(drained, ["fg1", "fg2", "cmd", "bg"]);
});

test("a higher-priority arrival jumps ahead of an already-queued lower-priority waiter", async () => {
  const h = harness();
  for (const pid of [1, 2, 3]) {
    h.spawn(pid);
  }
  await acquireAdmission(req("hold", 1, "foreground"), h.a);
  await acquireAdmission(req("bg", 2, "background"), h.a); // queues first
  await acquireAdmission(req("fg", 3, "foreground"), h.a); // arrives later but higher priority

  assert.deepEqual(await pollAdmission(KEY, "fg", h.a), { status: "queued", position: 0 });
  assert.deepEqual(await pollAdmission(KEY, "bg", h.a), { status: "queued", position: 1 });
});

test("cancelling (release) a queued request removes it from the queue without taking a slot", async () => {
  const h = harness();
  h.spawn(100);
  h.spawn(200);
  await acquireAdmission(req("a1", 100), h.a);
  await acquireAdmission(req("b1", 200), h.b);

  assert.deepEqual(await releaseAdmission(KEY, "b1", h.b), { released: true });
  assert.deepEqual(await pollAdmission(KEY, "b1", h.b), { status: "gone" });
  const view = inspectResource(KEY, h.a);
  assert.equal(view.queue.length, 0, "the cancelled waiter is gone");
  assert.equal(view.active[0]?.owner.ownerId, "a1", "the active holder is untouched");
});

test("releasing an already-gone owner is an idempotent no-op", async () => {
  const h = harness();
  h.spawn(100);
  await acquireAdmission(req("a1", 100), h.a);
  assert.deepEqual(await releaseAdmission(KEY, "a1", h.a), { released: true });
  assert.deepEqual(await releaseAdmission(KEY, "a1", h.a), { released: false });
  assert.deepEqual(await releaseAdmission(KEY, "never", h.a), { released: false });
});

test("a request whose own estimate exceeds the context window is refused before it queues", async () => {
  const h = harness();
  h.spawn(100);
  const estimate: AdmissionEstimate = {
    estimatedTokens: 5000,
    maxOutputTokens: 1000,
    contextWindowTokens: 4096,
  };
  assert.deepEqual(await acquireAdmission(req("a1", 100, "foreground", { estimate }), h.a), {
    status: "refused",
    refusal: "estimated_tokens_exceed_context_window",
  });
  assert.equal(inspectResource(KEY, h.a).active.length, 0, "a refused request holds nothing");
});

test("a request whose estimate plus active reservations overflows the window is refused (V1 budget)", async () => {
  const h = harness();
  h.spawn(100);
  h.spawn(200);
  const window = 4096;
  // a1 holds a big reservation; a2 alone fits but a1+a2 overflows -> refused (capacity 2 so it is the
  // budget, not the slot count, that refuses).
  await acquireAdmission(
    req("a1", 100, "foreground", {
      capacity: 2,
      estimate: { estimatedTokens: 3000, maxOutputTokens: 0, contextWindowTokens: window },
    }),
    h.a,
  );
  assert.deepEqual(
    await acquireAdmission(
      req("a2", 200, "foreground", {
        capacity: 2,
        estimate: { estimatedTokens: 2000, maxOutputTokens: 0, contextWindowTokens: window },
      }),
      h.b,
    ),
    { status: "refused", refusal: "active_reservations_exceed_context_window" },
  );
});

// --- snapshot + store-unavailable ---

test("snapshotAdmission reports every active resource, omitting drained-empty ones", async () => {
  const h = harness();
  h.spawn(100);
  h.spawn(200);
  const key2 = generationResourceKey("lmstudio", "http://localhost:1234/v1", "llama-3.3");
  await acquireAdmission(req("a1", 100), h.a);
  await acquireAdmission({ ...req("c1", 200), key: key2 }, h.b);

  const all = snapshotAdmission(h.a);
  assert.deepEqual(new Set(all.map((r) => r.key)), new Set([KEY, key2]));

  // Releasing empties one resource's file; the snapshot drops it.
  await releaseAdmission(KEY, "a1", h.a);
  assert.deepEqual(
    snapshotAdmission(h.a).map((r) => r.key),
    [key2],
  );
});

test("a permanently contended mutex surfaces AdmissionStoreUnavailable rather than hanging", async () => {
  // An fs whose mutex create never succeeds and whose mutex never ages out models a wedged peer holding
  // the lock; the bounded retry loop gives up with a typed error instead of blocking forever.
  let clock = 1_700_000_000_000;
  const fs: AdmissionFs = {
    readFile: () => null,
    writeFile: () => {},
    remove: () => {},
    createExclusive: () => false,
    renameIfExists: () => false, // never able to break the (always-fresh) mutex either
    mtimeMs: () => clock, // always "fresh" -> never broken as stale
    listResources: () => [],
  };
  const caps: AdmissionCaps = {
    fs,
    now: () => clock,
    processAlive: () => true,
    sleep: async (ms) => {
      clock += ms;
    },
    dir: ADMISSION_TEST_DIR,
  };
  await assert.rejects(
    () => acquireAdmission(req("a1", 100), caps),
    (err) => err instanceof AdmissionStoreUnavailable,
  );
});
