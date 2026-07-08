import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
  commandMatches,
  createJobLedger,
  type JobLedger,
  type ReconcileDeps,
  type RunningJobRecord,
  reconcileOrphanJobs,
} from "./job-ledger";

/**
 * The background-job watchdog (plan 09 hardening): the persisted running-job ledger and the pure,
 * command-verified orphan reconcile. A crashed host leaves dev servers/watchers running with no owner and
 * its last published snapshot reporting them as `running`; the ledger lets a restarting host tell its own
 * orphans apart and reap them safely (a reused pid is never killed).
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobs-ledger-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ledgerPath = () => join(dir, "jobs-ledger.json");

const record = (over: Partial<RunningJobRecord> = {}): RunningJobRecord => ({
  pid: 4242,
  command: "vite",
  startedAt: 1_000,
  ...over,
});

/** Fakes a world where `alive` pids exist, each with a fixed command line, and SIGTERM is recorded. */
function fakeDeps(
  commands: ReadonlyMap<number, string>,
  alive: (pid: number) => boolean = (pid) => commands.has(pid),
): { deps: ReconcileDeps; killed: number[] } {
  const killed: number[] = [];
  return {
    killed,
    deps: {
      isAlive: alive,
      commandOf: (pid) => commands.get(pid) ?? null,
      terminate: (pid) => {
        killed.push(pid);
      },
    },
  };
}

test("createJobLedger round-trips running jobs and tolerates a missing/corrupt file", () => {
  const ledger = createJobLedger(ledgerPath());
  assert.deepEqual(ledger.load(), {});
  ledger.replaceAll({ a: record({ pid: 1 }), b: record({ pid: 2, command: "npm run dev" }) });
  const loaded = ledger.load();
  assert.deepEqual(Object.keys(loaded).sort(), ["a", "b"]);
  assert.equal(loaded.a?.pid, 1);
  // replaceAll fully replaces (not merges): an empty map clears.
  ledger.replaceAll({});
  assert.deepEqual(ledger.load(), {});
});

test("createJobLedger treats a corrupt file as empty rather than throwing", () => {
  writeFileSync(ledgerPath(), "{not json");
  const ledger = createJobLedger(ledgerPath());
  assert.deepEqual(ledger.load(), {});
});

test("createJobLedger ignores malformed entries when loading", () => {
  writeFileSync(
    ledgerPath(),
    JSON.stringify({ ok: { pid: 1, command: "vite" }, bad: { pid: "x" }, nope: 7 }),
  );
  const loaded = createJobLedger(ledgerPath()).load();
  assert.deepEqual(Object.keys(loaded), ["ok"]);
});

test("reconcile kills an orphan that is alive AND command-verified, then owns the ledger", () => {
  const ledger = createJobLedger(ledgerPath());
  ledger.replaceAll({ p1: record({ pid: 100, command: "vite" }) });
  const { deps, killed } = fakeDeps(new Map([[100, "sh -c vite"]]));
  // The new host tracks nothing (fresh restart) -> p1 is an orphan.
  const out = reconcileOrphanJobs(ledger, {}, deps);
  assert.deepEqual(out.killed, [100]);
  assert.deepEqual(out.spared, []);
  assert.equal(killed.length, 1);
  // The ledger is rewritten to the new host's (empty) set, so the orphan won't be re-reaped.
  assert.deepEqual(ledger.load(), {});
});

test("reconcile SPARES a reused pid: alive but the command no longer matches -> never killed", () => {
  const ledger = createJobLedger(ledgerPath());
  ledger.replaceAll({ p1: record({ pid: 100, command: "vite" }) });
  // pid 100 now runs an unrelated process (pid reuse after the host crashed).
  const { deps, killed } = fakeDeps(new Map([[100, "some-other-app --foo"]]));
  const out = reconcileOrphanJobs(ledger, {}, deps);
  assert.deepEqual(out.killed, []);
  assert.deepEqual(out.spared, [100]);
  assert.equal(killed.length, 0);
});

test("reconcile spares an orphan whose pid is already gone (no exit to deliver)", () => {
  const ledger = createJobLedger(ledgerPath());
  ledger.replaceAll({ p1: record({ pid: 100 }), p2: record({ pid: 200 }) });
  // 100 died on its own; 200 is alive + verified.
  const { deps, killed } = fakeDeps(new Map([[200, "sh -c vite"]]), (pid) => pid === 200);
  const out = reconcileOrphanJobs(ledger, {}, deps);
  assert.deepEqual(out.killed, [200]);
  assert.deepEqual(out.spared, [100]);
  assert.equal(killed.length, 1);
});

test("reconcile keeps a job this host still tracks (not an orphan)", () => {
  const ledger = createJobLedger(ledgerPath());
  ledger.replaceAll({ p1: record({ pid: 100 }) });
  const { deps, killed } = fakeDeps(new Map([[100, "sh -c vite"]]));
  // The new host still tracks p1 -> it is live, not an orphan; never killed, kept in the ledger.
  const out = reconcileOrphanJobs(ledger, { p1: record({ pid: 100 }) }, deps);
  assert.deepEqual(out.killed, []);
  assert.deepEqual(out.spared, []);
  assert.equal(killed.length, 0);
  assert.equal(ledger.load().p1?.pid, 100);
});

test("reconcile spares an orphan whose command line can't be read (ps failed)", () => {
  const ledger = createJobLedger(ledgerPath());
  ledger.replaceAll({ p1: record({ pid: 100 }) });
  // Alive, but commandOf returns null (ps couldn't describe it) -> can't verify -> spare.
  const { deps, killed } = fakeDeps(new Map(), () => true);
  const out = reconcileOrphanJobs(ledger, {}, deps);
  assert.deepEqual(out.killed, []);
  assert.deepEqual(out.spared, [100]);
  assert.equal(killed.length, 0);
});

test("commandMatches is conservative: empty/missing description spares; substring confirms", () => {
  assert.equal(commandMatches(record({ command: "vite" }), "sh -c vite --port 3000"), true);
  assert.equal(commandMatches(record({ command: "vite" }), null), false);
  assert.equal(commandMatches(record({ command: "vite" }), "   "), false);
  assert.equal(commandMatches(record({ command: "vite" }), "unrelated-server"), false);
});

test("reconcile persists the rewritten ledger to disk", () => {
  const path = ledgerPath();
  const ledger = createJobLedger(path) as JobLedger;
  ledger.replaceAll({ p1: record({ pid: 100 }) });
  const { deps } = fakeDeps(new Map([[100, "sh -c vite"]]));
  reconcileOrphanJobs(ledger, { p2: record({ pid: 300, command: "webpack" }) }, deps);
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, RunningJobRecord>;
  assert.deepEqual(Object.keys(onDisk), ["p2"]);
  assert.equal(onDisk.p2?.pid, 300);
});
