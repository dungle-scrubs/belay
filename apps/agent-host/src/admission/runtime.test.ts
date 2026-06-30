import assert from "node:assert/strict";
import { test } from "vitest";
import type { AdmissionEstimate, AdmissionOwner } from "./contract";
import { generationResourceKey } from "./contract";
import { type AdmissionStatusUpdate, admit } from "./runtime";
import { type AdmissionCaps, type AdmissionFs, acquireAdmission, inspectResource } from "./store";

/**
 * The admission runtime facade (plan 11 M5/M6): the wait-then-hold handle the provider wraps. Pins the
 * acquire-immediately, wait-then-acquire, cancel-while-queued, fail-open-refusal, and release paths over
 * the same in-memory fs harness as the store, so no real processes/timers are needed.
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
  return { caps, spawn: (pid: number) => alive.add(pid) };
}

function owner(ownerId: string, pid: number): AdmissionOwner {
  return { ownerId, hostId: `host-${pid}`, pid, provider: "lmstudio", model: "qwen3.6-27b-mlx" };
}

test("admit acquires immediately when the resource is free and the handle releases the slot", async () => {
  const h = harness();
  h.spawn(1);
  const statuses: AdmissionStatusUpdate[] = [];
  const handle = await admit(
    { key: KEY, owner: owner("w", 1), priority: "foreground", onStatus: (s) => statuses.push(s) },
    h.caps,
  );
  assert.equal(handle.held, true);
  assert.equal(handle.ownerId, "w");
  assert.deepEqual(statuses, [{ phase: "acquired" }]);
  assert.equal(inspectResource(KEY, h.caps).active.length, 1);

  await handle.release("success");
  assert.equal(inspectResource(KEY, h.caps).active.length, 0, "release frees the slot");
});

test("admit waits in the queue and acquires once the holder releases", async () => {
  const h = harness();
  h.spawn(1);
  h.spawn(2);
  await acquireAdmission(
    {
      key: KEY,
      owner: owner("holder", 1),
      priority: "foreground",
      estimate: { estimatedTokens: 0, maxOutputTokens: 0, contextWindowTokens: 0 },
    },
    h.caps,
  );

  const statuses: AdmissionStatusUpdate[] = [];
  const waiting = admit(
    {
      key: KEY,
      owner: owner("w", 2),
      priority: "foreground",
      pollIntervalMs: 1,
      onStatus: (s) => statuses.push(s),
    },
    h.caps,
  );
  // Let the waiter queue + enter its poll loop, then release the holder (whose drain promotes the waiter).
  await Promise.resolve();
  const { releaseAdmission } = await import("./store");
  await releaseAdmission(KEY, "holder", h.caps);

  const handle = await waiting;
  assert.equal(handle.held, true);
  assert.ok(
    statuses.some((s) => s.phase === "queued"),
    "the waiter reported a queued phase",
  );
  assert.ok(
    statuses.some((s) => s.phase === "acquired"),
    "the waiter reported acquiring",
  );
  await handle.release("success");
});

test("aborting the signal while queued cancels the request and yields a no-op handle", async () => {
  const h = harness();
  h.spawn(1);
  h.spawn(2);
  await acquireAdmission(
    {
      key: KEY,
      owner: owner("holder", 1),
      priority: "foreground",
      estimate: { estimatedTokens: 0, maxOutputTokens: 0, contextWindowTokens: 0 },
    },
    h.caps,
  );
  const controller = new AbortController();
  controller.abort(); // already aborted: the wait bails on the first check

  const handle = await admit(
    {
      key: KEY,
      owner: owner("w", 2),
      priority: "foreground",
      pollIntervalMs: 1,
      signal: controller.signal,
    },
    h.caps,
  );
  assert.equal(handle.held, false, "a cancelled wait holds nothing");
  // The cancelled waiter left no queue entry behind.
  assert.equal(inspectResource(KEY, h.caps).queue.length, 0);
});

test("a context-budget refusal fails open to a no-op handle (the turn still runs)", async () => {
  const h = harness();
  h.spawn(1);
  const estimate: AdmissionEstimate = {
    estimatedTokens: 9000,
    maxOutputTokens: 0,
    contextWindowTokens: 4096,
  };
  const reports: string[] = [];
  const handle = await admit(
    { key: KEY, owner: owner("w", 1), priority: "foreground", estimate },
    h.caps,
    (event) => reports.push(event),
  );
  assert.equal(handle.held, false, "a refused request fails open, holding nothing");
  assert.ok(reports.includes("admission.refused"), "the refusal is reported");
  // Releasing a no-op handle is a harmless no-op.
  await handle.release("success");
});
