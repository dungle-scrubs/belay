import assert from "node:assert/strict";
import { test } from "vitest";
import { fakeLauncherFs } from "../test/fake-fs";
import {
  acquireLock,
  decideHostAction,
  type HostRecord,
  loadHosts,
  reapDeadHosts,
  recordHost,
  releaseLock,
  removeHost,
} from "./host-registry";

/**
 * Host lifecycle bookkeeping (D-085 M3): ownership records, the reuse/stale/spawn decision, and the
 * per-session lock that stops two concurrent launches from both spawning. Pure over an in-memory fs.
 */

const record = (over: Partial<HostRecord> = {}): HostRecord => ({
  sessionId: "sess",
  pid: 4242,
  root: "/work/app",
  command: "tsx agent-host",
  startedAt: "2026-06-26T00:00:00Z",
  ...over,
});

test("recordHost / loadHosts / removeHost round-trip", () => {
  const fs = fakeLauncherFs();
  recordHost(fs, "/home", record());
  assert.equal(loadHosts(fs, "/home").sess?.pid, 4242);
  removeHost(fs, "/home", "sess");
  assert.deepEqual(loadHosts(fs, "/home"), {});
});

test("decideHostAction: spawn (no record), reuse (alive + present), replace-stale (dead / absent)", () => {
  const alive = () => true;
  const dead = () => false;
  assert.equal(decideHostAction(null, { processAlive: alive, hostPresent: false }), "spawn");
  assert.equal(decideHostAction(record(), { processAlive: alive, hostPresent: true }), "reuse");
  // Process gone, or alive but no host answering the session (a leftover record): replace.
  assert.equal(
    decideHostAction(record(), { processAlive: dead, hostPresent: true }),
    "replace-stale",
  );
  assert.equal(
    decideHostAction(record(), { processAlive: alive, hostPresent: false }),
    "replace-stale",
  );
});

test("reapDeadHosts sweeps only dead-pid records and is a no-op write when all are alive", () => {
  const fs = fakeLauncherFs();
  recordHost(fs, "/home", record({ sessionId: "alive-a", pid: 1 }));
  recordHost(fs, "/home", record({ sessionId: "dead-b", pid: 2 }));
  recordHost(fs, "/home", record({ sessionId: "dead-c", pid: 3 }));

  // pid 1 is alive; pids 2 and 3 are gone.
  const alive = (pid: number) => pid === 1;
  const reaped = reapDeadHosts(fs, "/home", alive);
  assert.deepEqual([...reaped].sort(), ["dead-b", "dead-c"]);

  const remaining = loadHosts(fs, "/home");
  assert.deepEqual(Object.keys(remaining), ["alive-a"]);
  assert.equal(remaining["alive-a"]?.pid, 1);
});

test("reapDeadHosts never reaps a live host whose pid was reused (conservative bias)", () => {
  const fs = fakeLauncherFs();
  // A dead host whose pid (4242) was since taken by an UNRELATED live process: kill(pid,0) says alive.
  recordHost(fs, "/home", record({ sessionId: "reused", pid: 4242 }));
  const reaped = reapDeadHosts(fs, "/home", () => true);
  assert.deepEqual(reaped, []);
  // The record stays rather than being wrongly dropped.
  assert.equal(loadHosts(fs, "/home").reused?.pid, 4242);
});

test("acquireLock blocks a live concurrent holder, takes over a dead one, and releases cleanly", () => {
  const fs = fakeLauncherFs();
  // Launcher A (pid 100) acquires.
  const a = acquireLock(fs, "/home", "sess", { pid: 100, now: "t", processAlive: () => true });
  assert.deepEqual(a, { acquired: true });

  // Launcher B (pid 200) sees A's live lock and is blocked - it must not spawn.
  const blocked = acquireLock(fs, "/home", "sess", {
    pid: 200,
    now: "t",
    processAlive: (pid) => pid === 100, // A still alive
  });
  assert.deepEqual(blocked, { acquired: false, heldBy: 100 });

  // B does not own the lock, so its release is a no-op (never steals A's).
  releaseLock(fs, "/home", "sess", 200);
  const stillBlocked = acquireLock(fs, "/home", "sess", {
    pid: 200,
    now: "t",
    processAlive: (pid) => pid === 100,
  });
  assert.deepEqual(stillBlocked, { acquired: false, heldBy: 100 });

  // Once A's process is gone, its lock is stale and B takes over.
  const takeover = acquireLock(fs, "/home", "sess", {
    pid: 200,
    now: "t",
    processAlive: () => false,
  });
  assert.deepEqual(takeover, { acquired: true });
});
