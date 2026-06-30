import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type AdmissionOwner,
  type AdmissionPriority,
  generationResourceKey,
  NO_ESTIMATE,
} from "./contract";
import {
  type AdmissionCaps,
  type AdmissionFs,
  acquireAdmission,
  inspectResource,
  pollAdmission,
  releaseAdmission,
} from "./store";

/**
 * Parallel subagent load (plan 11 M10): multiple background/subagent local-model requests targeting the
 * SAME LM Studio resource must queue behind foreground user work and drain without starvation, and
 * cancelling a parent run must release its queued AND active subagent reservations. Driven over the
 * in-memory store harness; the cross-process flavor is the M9 e2e.
 */

const DIR = "/state/admission";
const KEY = generationResourceKey("lmstudio", "http://localhost:1234/v1", "qwen3.6-27b-mlx");

function harness() {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const alive = new Set<number>();
  let clock = 1_700_000_000_000;
  const fs: AdmissionFs = {
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => {
      files.set(p, c);
      mtimes.set(p, clock);
    },
    remove: (p) => {
      files.delete(p);
      mtimes.delete(p);
    },
    createExclusive: (p) => {
      if (files.has(p)) {
        return false;
      }
      files.set(p, "");
      mtimes.set(p, clock);
      return true;
    },
    mtimeMs: (p) => mtimes.get(p) ?? null,
    listResources: () => [],
  };
  const caps: AdmissionCaps = {
    fs,
    now: () => clock,
    processAlive: (pid) => alive.has(pid),
    sleep: async (ms) => {
      clock += ms;
    },
    dir: DIR,
  };
  return { caps, advance: (ms: number) => (clock += ms), spawn: (pid: number) => alive.add(pid) };
}

function owner(ownerId: string, pid: number, agentId?: string): AdmissionOwner {
  return {
    ownerId,
    hostId: `host-${pid}`,
    pid,
    provider: "lmstudio",
    model: "qwen3.6-27b-mlx",
    ...(agentId ? { runId: agentId } : {}),
  };
}

function acquire(caps: AdmissionCaps, ownerId: string, pid: number, priority: AdmissionPriority) {
  return acquireAdmission(
    { key: KEY, owner: owner(ownerId, pid, ownerId), priority, estimate: NO_ESTIMATE, capacity: 1 },
    caps,
  );
}

test("background subagents queue behind a foreground turn and drain FIFO without starvation", async () => {
  const h = harness();
  for (const pid of [1, 2, 3, 4]) {
    h.spawn(pid);
  }
  // A foreground user turn holds the single local slot.
  assert.deepEqual(await acquire(h.caps, "fg", 1, "foreground"), { status: "acquired" });
  // Three parallel subagents target the same model -> all queue (capacity 1).
  assert.deepEqual(await acquire(h.caps, "sub1", 2, "background"), {
    status: "queued",
    position: 0,
  });
  h.advance(5);
  assert.deepEqual(await acquire(h.caps, "sub2", 3, "background"), {
    status: "queued",
    position: 1,
  });
  h.advance(5);
  assert.deepEqual(await acquire(h.caps, "sub3", 4, "background"), {
    status: "queued",
    position: 2,
  });

  // Drain: the foreground releases; the subagents each acquire in FIFO order, none starved.
  await releaseAdmission(KEY, "fg", h.caps);
  const drained: string[] = [];
  for (const id of ["sub1", "sub2", "sub3"]) {
    assert.deepEqual(await pollAdmission(KEY, id, h.caps), { status: "acquired" }, `${id} drains`);
    drained.push(id);
    await releaseAdmission(KEY, id, h.caps);
  }
  assert.deepEqual(
    drained,
    ["sub1", "sub2", "sub3"],
    "every subagent eventually ran (no starvation)",
  );
});

test("a foreground turn preempts already-queued subagents", async () => {
  const h = harness();
  for (const pid of [1, 2, 3]) {
    h.spawn(pid);
  }
  await acquire(h.caps, "holder", 1, "foreground");
  await acquire(h.caps, "sub1", 2, "background");
  await acquire(h.caps, "sub2", 3, "background");
  // A new foreground user turn arrives after the subagents queued; it jumps to the front.
  assert.deepEqual(await acquire(h.caps, "fg2", 1, "foreground"), {
    status: "queued",
    position: 0,
  });

  await releaseAdmission(KEY, "holder", h.caps);
  assert.deepEqual(
    await pollAdmission(KEY, "fg2", h.caps),
    { status: "acquired" },
    "foreground first",
  );
  assert.deepEqual(await pollAdmission(KEY, "sub1", h.caps), { status: "queued", position: 0 });
});

test("cancelling a parent releases its queued AND active subagent reservations", async () => {
  const h = harness();
  for (const pid of [1, 2, 3]) {
    h.spawn(pid);
  }
  // An active subagent generation and a queued one (e.g. two children of one parent run).
  await acquire(h.caps, "active-child", 1, "background");
  await acquire(h.caps, "queued-child", 2, "background");
  assert.equal(inspectResource(KEY, h.caps).active[0]?.owner.ownerId, "active-child");
  assert.equal(inspectResource(KEY, h.caps).queue[0]?.owner.ownerId, "queued-child");

  // Parent cancellation tears down both children's reservations.
  assert.deepEqual(await releaseAdmission(KEY, "queued-child", h.caps), { released: true });
  assert.deepEqual(await releaseAdmission(KEY, "active-child", h.caps), { released: true });
  const view = inspectResource(KEY, h.caps);
  assert.equal(view.active.length, 0, "no active reservation lingers after parent cancel");
  assert.equal(view.queue.length, 0, "no queued reservation lingers after parent cancel");
});
