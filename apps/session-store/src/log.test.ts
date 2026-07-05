import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { frames } from "@trevor/session";
import { SPAN_NAMES } from "@trevor/session/telemetry";
import { recordingTelemetrySink, tempDir } from "@trevor/test-kit";
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

test("readFrames is readAfter mapped through frames.event - same frames, order, cursor", () => {
  const log = new SessionLog(":memory:");
  log.append("s1", { type: "a", producerId: "host", payload: { n: 1 } }, "e1", at);
  log.append("s1", { type: "b", producerId: "host", payload: { n: 2 } }, "e2", at);
  log.append("s1", { type: "c", producerId: "host", payload: { n: 3 } }, "e3", at);

  // readFrames returns ready-to-send wire frames - exactly readAfter mapped through frames.event.
  for (const cursor of [0, 1, 2, 3]) {
    assert.deepEqual(
      log.readFrames("s1", cursor),
      log.readAfter("s1", cursor).map((e) => frames.event(e)),
    );
  }

  // Spot-check the shape: each is a wire `{op:"event", event}` frame, in seq order.
  const all = log.readFrames("s1", 0);
  assert.deepEqual(
    all.map((f) => (f.op === "event" ? f.event.seq : null)),
    [1, 2, 3],
  );
  assert.equal(all[0]?.op, "event");
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

test("inventory() lifecycle slice picks exactly the protocol's LIFECYCLE_TYPES, in seq order", () => {
  const log = new SessionLog(":memory:");
  // A spread of lifecycle + non-lifecycle events: only assistant.started/completed and
  // user.command are lifecycle; everything else (deltas, tool calls, host beats) is noise.
  log.append("s1", { type: "user.message", producerId: "web", payload: {} }, "e1", at);
  log.append("s1", { type: "assistant.started", producerId: "host", payload: {} }, "e2", at);
  log.append("s1", { type: "assistant.delta", producerId: "host", payload: {} }, "e3", at);
  log.append("s1", { type: "tool.started", producerId: "host", payload: {} }, "e4", at);
  log.append("s1", { type: "assistant.completed", producerId: "host", payload: {} }, "e5", at);
  log.append("s1", { type: "host.beat", producerId: "host", payload: {} }, "e6", at);
  log.append("s1", { type: "user.command", producerId: "web", payload: {} }, "e7", at);

  const s1 = log.inventory().find((r) => r.sessionId === "s1");
  assert.deepEqual(
    s1?.lifecycle.map((e) => e.type),
    ["assistant.started", "assistant.completed", "user.command"],
  );
  assert.deepEqual(
    s1?.lifecycle.map((e) => e.seq),
    [2, 5, 7],
  );
});

test("append emits a store.append span carrying the event type + producer, never the session id or payload", () => {
  const recorder = recordingTelemetrySink();
  const log = new SessionLog(":memory:", recorder.sink);
  log.append(
    "secret-session-id",
    { type: "user.message", producerId: "web", payload: { text: "private prompt body" } },
    "e1",
    at,
  );

  const spans = recorder.named(SPAN_NAMES.storeAppend);
  assert.equal(spans.length, 1);
  const [span] = spans;
  assert.equal(span?.status, "ok");
  assert.equal(span?.attributes.event_type, "user.message");
  assert.equal(span?.attributes.producer, "web");
  const serialized = JSON.stringify(spans);
  assert.ok(!serialized.includes("secret-session-id"), "the session id never enters a span");
  assert.ok(!serialized.includes("private prompt body"), "the payload never enters a span");
});

test("type lookups seek the (sessionId, type) index with no filesort", () => {
  const log = new SessionLog(":memory:");
  log.append("s1", { type: "host.online", producerId: "host", payload: {} }, "e1", at);

  // The per-session type lookup must resolve via the (sessionId, type, seq) index - a direct seek that
  // also yields seq order for free - not a whole-session scan followed by a sort. Fails before the index
  // exists (the PK (sessionId, seq) can only seek sessionId, then scans + filters type).
  const plan = log.explainTypeLookup();
  assert.ok(plan.includes("events_session_type_seq"), `expected an index seek, got: ${plan}`);
  assert.ok(!plan.includes("TEMP B-TREE"), `expected no filesort, got: ${plan}`);
});

test("the type index is created idempotently on an existing (pre-index) DB", () => {
  const dir = tempDir("trevor-index-");
  const path = join(dir, "sessions.db");
  try {
    // First open builds the schema + index and lands real data; reopening the same file must not error
    // (CREATE INDEX IF NOT EXISTS is a no-op) and the index must still be present + used.
    const first = new SessionLog(path);
    first.append("s1", { type: "host.online", producerId: "host", payload: {} }, "e1", at);

    const reopened = new SessionLog(path);
    assert.ok(reopened.explainTypeLookup().includes("events_session_type_seq"));
    assert.equal(reopened.readAfter("s1", 0).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
