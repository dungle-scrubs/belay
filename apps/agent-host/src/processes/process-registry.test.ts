import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { type JobOrigin, ProcessRegistry } from "./process-registry";

/**
 * M2: the promoted-job metadata + structured JobSnapshot read model. A directly-started `process` job
 * carries no run/tool origin; a promoted bash/shell job carries its source, originating ids, cwd, and a
 * promotedAt timestamp. Only *visible* jobs (direct `process` starts + promoted commands) appear in
 * snapshots(); a bash/shell command becomes visible once markPromoted stamps it. The model-facing
 * `list()` (JobInfo) is unchanged. (`true` exits immediately, but a synchronous snapshot right after
 * start reads "running" before the async exit handler fires; we spawn in a real cwd.)
 */

const CWD = process.cwd();
const reg = new ProcessRegistry();
afterEach(() => {
  reg.killAll();
  reg.clearCompleted();
  reg.onChange = undefined;
  vi.useRealTimers();
});

const bashOrigin: JobOrigin = { source: "bash", runId: "r1", callId: "c1" };

async function waitForExit(id: string): Promise<void> {
  await reg.awaitExit(id);
}

test("a direct process start defaults to source `process` with no origin ids", () => {
  const { id } = reg.start("true", CWD);
  const snap = reg.snapshots().find((s) => s.id === id);
  assert.equal(snap?.source, "process");
  assert.equal(snap?.runId, undefined);
  assert.equal(snap?.promotedAt, undefined);
  assert.equal(snap?.cwd, CWD);
});

test("a promoted job snapshot carries source, originating ids, cwd, and promotedAt", () => {
  const { id } = reg.start("true", CWD, bashOrigin);
  reg.markPromoted(id, 1000);
  const snap = reg.snapshots().find((s) => s.id === id);
  assert.equal(snap?.source, "bash");
  assert.equal(snap?.runId, "r1");
  assert.equal(snap?.callId, "c1");
  assert.equal(snap?.cwd, CWD, "the spawn cwd is the snapshot cwd");
  assert.equal(snap?.promotedAt, 1000);
  assert.equal(snap?.status, "running");
  assert.equal(typeof snap?.stdoutTotal, "number");
});

test("a bash/shell command is invisible to the panel until it is promoted", () => {
  const { id } = reg.start("true", CWD, bashOrigin);
  assert.equal(
    reg.snapshots().find((s) => s.id === id),
    undefined,
    "a foreground command in its pre-promotion window is not a panel job",
  );
  reg.markPromoted(id, 1);
  assert.ok(
    reg.snapshots().find((s) => s.id === id),
    "visible once promoted",
  );
});

test("markPromoted stamps a tracked job once (idempotent)", () => {
  const { id } = reg.start("true", CWD, bashOrigin);
  reg.markPromoted(id, 2000);
  assert.equal(reg.snapshots().find((s) => s.id === id)?.promotedAt, 2000);
  reg.markPromoted(id, 9999); // already promoted -> ignored
  assert.equal(reg.snapshots().find((s) => s.id === id)?.promotedAt, 2000);
  reg.markPromoted("nope", 1); // unknown id -> no throw
});

test("the model-facing list() read model is unchanged (id/command/status/exitCode/ageMs)", () => {
  const { id } = reg.start("true", CWD, bashOrigin);
  const row = reg.list().find((j) => j.id === id);
  assert.deepEqual(Object.keys(row ?? {}).sort(), ["ageMs", "command", "exitCode", "id", "status"]);
  assert.equal(row?.command, "true");
});

test("dismiss removes an exited visible job and triggers one visible change", async () => {
  const { id } = reg.start("true", CWD);
  await waitForExit(id);
  const changes: string[] = [];
  reg.onChange = () => changes.push("changed");

  const result = reg.dismiss(id);

  assert.deepEqual(result, { id, status: "dismissed" });
  assert.equal(
    reg.snapshots().find((s) => s.id === id),
    undefined,
    "dismissed jobs leave the host.online snapshot",
  );
  assert.equal(
    reg.list().find((j) => j.id === id),
    undefined,
    "dismissed jobs leave the model-facing list too",
  );
  assert.equal(changes.length, 1);
});

test("dismiss refuses unknown and running jobs without removing them", () => {
  assert.throws(() => reg.dismiss("nope"), /no such process "nope"/u);

  const { id } = reg.start("sleep 5", CWD);

  assert.throws(() => reg.dismiss(id), /cannot dismiss running process "p\d+"; stop it first/u);
  assert.equal(reg.list().find((j) => j.id === id)?.status, "running");
  assert.equal(reg.snapshots().find((s) => s.id === id)?.status, "running");
});

test("clearCompleted removes terminal jobs, keeps running jobs, and triggers one visible change", async () => {
  const exited = reg.start("true", CWD).id;
  const killed = reg.start("sleep 5", CWD).id;
  const running = reg.start("sleep 5", CWD).id;
  reg.kill(killed);
  await waitForExit(exited);
  const changes: string[] = [];
  reg.onChange = () => changes.push("changed");

  const result = reg.clearCompleted();

  assert.deepEqual(result, { dismissed: 2 });
  assert.equal(
    reg.list().find((j) => j.id === exited),
    undefined,
  );
  assert.equal(
    reg.list().find((j) => j.id === killed),
    undefined,
  );
  assert.equal(reg.list().find((j) => j.id === running)?.status, "running");
  assert.equal(changes.length, 1);
});

test("successful exited jobs are auto-pruned after the grace period", async () => {
  vi.useFakeTimers();
  const { id } = reg.start("true", CWD);
  await waitForExit(id);
  const changes: string[] = [];
  reg.onChange = () => changes.push("changed");

  await vi.advanceTimersByTimeAsync(ProcessRegistry.SUCCESS_AUTO_PRUNE_MS - 1);
  assert.ok(
    reg.list().some((job) => job.id === id),
    "job remains visible during the grace period",
  );

  await vi.advanceTimersByTimeAsync(1);

  assert.equal(
    reg.list().find((job) => job.id === id),
    undefined,
  );
  assert.equal(
    reg.snapshots().find((snapshot) => snapshot.id === id),
    undefined,
  );
  assert.equal(changes.length, 1);
});

test("auto-prune keeps failed, killed, and running jobs", async () => {
  vi.useFakeTimers();
  const failed = reg.start("false", CWD).id;
  const killed = reg.start("sleep 5", CWD).id;
  const running = reg.start("sleep 5", CWD).id;
  reg.kill(killed);
  await waitForExit(failed);

  await vi.advanceTimersByTimeAsync(ProcessRegistry.SUCCESS_AUTO_PRUNE_MS);

  assert.equal(reg.list().find((job) => job.id === failed)?.status, "exited");
  assert.equal(reg.list().find((job) => job.id === killed)?.status, "killed");
  assert.equal(reg.list().find((job) => job.id === running)?.status, "running");
});

test("manual cleanup cancels pending auto-prune timers", async () => {
  vi.useFakeTimers();
  const dismissed = reg.start("true", CWD).id;
  const cleared = reg.start("true", CWD).id;
  const killed = reg.start("true", CWD).id;
  await waitForExit(dismissed);
  await waitForExit(cleared);
  await waitForExit(killed);

  reg.dismiss(dismissed);
  reg.clearCompleted();
  reg.killAll();

  assert.equal(vi.getTimerCount(), 0);
});
