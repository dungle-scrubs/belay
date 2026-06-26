import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionLog } from "./log";

const at = "2026-06-24T00:00:00.000Z";

test("ensureSession is idempotent", () => {
  const log = new SessionLog(":memory:");
  assert.equal(log.ensureSession("s1", at), "s1");
  assert.equal(log.ensureSession("s1", at), "s1");
});

test("append assigns dense, monotonic, per-session seq", () => {
  const log = new SessionLog(":memory:");
  const a = log.append("s1", { type: "user.message", producerId: "web", payload: {} }, "e1", at);
  const b = log.append(
    "s1",
    { type: "assistant.delta", producerId: "host", payload: {} },
    "e2",
    at,
  );
  const other = log.append(
    "s2",
    { type: "user.message", producerId: "web", payload: {} },
    "e3",
    at,
  );
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  // seq is per-session: a fresh session starts at 1 again.
  assert.equal(other.seq, 1);
});

test("readAfter returns events with seq > cursor, in order, payload preserved", () => {
  const log = new SessionLog(":memory:");
  log.append("s1", { type: "a", producerId: "host", payload: { n: 1 } }, "e1", at);
  log.append("s1", { type: "b", producerId: "host", payload: { n: 2 } }, "e2", at);
  log.append("s1", { type: "c", producerId: "host", payload: { n: 3 } }, "e3", at);

  const all = log.readAfter("s1", 0);
  assert.deepEqual(
    all.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.deepEqual(all[0]?.payload, { n: 1 });

  const tail = log.readAfter("s1", 1);
  assert.deepEqual(
    tail.map((e) => e.type),
    ["b", "c"],
  );
  assert.equal(log.readAfter("s1", 3).length, 0);
});

test("inventory() gathers per-session aggregates + the title/host/lifecycle source events", () => {
  const log = new SessionLog(":memory:");
  // s1: a user message, two host.online (latest wins), a started run, an empty session s2.
  log.append(
    "s1",
    { type: "user.message", producerId: "web", payload: { text: "hello" } },
    "e1",
    at,
  );
  log.append(
    "s1",
    { type: "host.online", producerId: "host", payload: { cwd: "~/old" } },
    "e2",
    "2026-06-24T00:01:00.000Z",
  );
  log.append(
    "s1",
    { type: "host.online", producerId: "host", payload: { cwd: "~/new" } },
    "e3",
    "2026-06-24T00:02:00.000Z",
  );
  log.append(
    "s1",
    { type: "assistant.started", producerId: "host", payload: { runId: "r1" } },
    "e4",
    "2026-06-24T00:03:00.000Z",
  );
  log.ensureSession("s2", at);

  const rows = log.inventory().sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  assert.equal(rows.length, 2);

  const s1 = rows[0];
  assert.equal(s1?.sessionId, "s1");
  assert.equal(s1?.eventCount, 4);
  assert.equal(s1?.updatedAt, "2026-06-24T00:03:00.000Z");
  assert.equal((s1?.firstUser?.payload as { text?: string }).text, "hello");
  // latest host.online wins
  assert.equal((s1?.hostOnline?.payload as { cwd?: string }).cwd, "~/new");
  assert.equal(s1?.lifecycle.length, 1);
  assert.equal(s1?.lifecycle[0]?.type, "assistant.started");

  // An empty session: no events, count 0, source events null.
  const s2 = rows[1];
  assert.equal(s2?.eventCount, 0);
  assert.equal(s2?.hostOnline, null);
  assert.equal(s2?.firstUser, null);
});
