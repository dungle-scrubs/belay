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
