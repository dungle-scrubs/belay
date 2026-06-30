import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { type JobMeta, ProcessRegistry } from "./process-registry";

/**
 * M2: the promoted-job metadata + structured JobSnapshot read model. A directly-started `process` job
 * carries no run/tool origin; a promoted bash/shell job carries its source, originating ids, cwd, and a
 * promotedAt timestamp. The model-facing `list()` (JobInfo) is unchanged; `snapshots()` is the richer,
 * session-visible read model the support panel + detail takeover consume. (`true` exits immediately, but
 * a synchronous snapshot right after start reads "running" before the async exit handler fires; we spawn
 * in a real cwd and keep the metadata cwd as plain data.)
 */

const CWD = process.cwd();
const reg = new ProcessRegistry();
afterEach(() => reg.killAll());

const promoted: JobMeta = {
  origin: { source: "bash", runId: "r1", callId: "c1" },
  cwd: "/work",
  promotedAt: 1000,
};

test("a direct process start defaults to source `process` with no origin ids", () => {
  const { id } = reg.start("true", CWD);
  const snap = reg.snapshots().find((s) => s.id === id);
  assert.equal(snap?.source, "process");
  assert.equal(snap?.runId, undefined);
  assert.equal(snap?.promotedAt, undefined);
  assert.equal(snap?.cwd, CWD);
});

test("a promoted job snapshot carries source, originating ids, cwd, and promotedAt", () => {
  const { id } = reg.start("true", CWD, promoted);
  const snap = reg.snapshots().find((s) => s.id === id);
  assert.equal(snap?.source, "bash");
  assert.equal(snap?.runId, "r1");
  assert.equal(snap?.callId, "c1");
  assert.equal(snap?.cwd, "/work", "the metadata cwd is the snapshot cwd, not the spawn cwd");
  assert.equal(snap?.promotedAt, 1000);
  assert.equal(snap?.status, "running");
  assert.equal(typeof snap?.stdoutTotal, "number");
});

test("markPromoted stamps a tracked job once (idempotent)", () => {
  const { id } = reg.start("true", CWD);
  reg.markPromoted(id, 2000);
  assert.equal(reg.snapshots().find((s) => s.id === id)?.promotedAt, 2000);
  reg.markPromoted(id, 9999); // already promoted -> ignored
  assert.equal(reg.snapshots().find((s) => s.id === id)?.promotedAt, 2000);
  reg.markPromoted("nope", 1); // unknown id -> no throw
});

test("the model-facing list() read model is unchanged (id/command/status/exitCode/ageMs)", () => {
  const { id } = reg.start("true", CWD, promoted);
  const row = reg.list().find((j) => j.id === id);
  assert.deepEqual(Object.keys(row ?? {}).sort(), ["ageMs", "command", "exitCode", "id", "status"]);
  assert.equal(row?.command, "true");
});
