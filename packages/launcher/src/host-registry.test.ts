import assert from "node:assert/strict";
import { test } from "vitest";
import type { LauncherFs } from "./fs";
import {
  acquireLock,
  decideHostAction,
  type HostRecord,
  loadHosts,
  recordHost,
  releaseLock,
  removeHost,
} from "./host-registry";

/**
 * Host lifecycle bookkeeping (D-085 M3): ownership records, the reuse/stale/spawn decision, and the
 * per-session lock that stops two concurrent launches from both spawning. Pure over an in-memory fs.
 */

function fakeFs(): LauncherFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content) => void files.set(path, content),
    exists: (path) => files.has(path),
    remove: (path) => void files.delete(path),
  };
}

const record = (over: Partial<HostRecord> = {}): HostRecord => ({
  sessionId: "sess",
  pid: 4242,
  root: "/work/app",
  command: "tsx agent-host",
  startedAt: "2026-06-26T00:00:00Z",
  ...over,
});

test("recordHost / loadHosts / removeHost round-trip", () => {
  const fs = fakeFs();
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

test("acquireLock blocks a live concurrent holder, takes over a dead one, and releases cleanly", () => {
  const fs = fakeFs();
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
