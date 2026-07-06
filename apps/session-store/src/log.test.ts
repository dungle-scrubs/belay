import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { frames } from "@trevor/session";
import { NOOP_SINK, SPAN_NAMES } from "@trevor/session/telemetry";
import { recordingTelemetrySink, tempDir } from "@trevor/test-kit";
import { test } from "vitest";
import { SESSION_LOG_SCHEMA_VERSION, SessionLog } from "./log";

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

test("diag reports unhealthy when the type index is absent and healthy when it is present", () => {
  const dir = tempDir("trevor-diag-");
  const path = join(dir, "sessions.db");
  try {
    const log = new SessionLog(path, NOOP_SINK, () => 0, "abc123");
    log.append("s1", { type: "host.online", producerId: "host", payload: {} }, "e1", at);

    const before = log.diag();
    assert.equal(before.indexHealthy, true);
    assert.equal(before.queries, 3);
    assert.equal(before.slowQueries, 0);
    assert.equal(before.startupSha, "abc123");

    const withoutIndex = new DatabaseSync(path);
    withoutIndex.exec("PRAGMA user_version = 37;");
    withoutIndex.exec("DROP INDEX events_session_type_seq;");
    withoutIndex.close();

    const missing = log.diag();
    assert.equal(missing.indexHealthy, false);
    assert.equal(missing.schemaVersion, 37);

    const withIndex = new DatabaseSync(path);
    withIndex.exec("CREATE INDEX events_session_type_seq ON events(sessionId, type, seq);");
    withIndex.close();

    assert.equal(log.diag().indexHealthy, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("opening the log stamps SQLite user_version to the current schema version", () => {
  const dir = tempDir("trevor-user-version-");
  const path = join(dir, "sessions.db");
  try {
    const log = new SessionLog(path);
    assert.equal(log.diag().schemaVersion, SESSION_LOG_SCHEMA_VERSION);

    const reopened = new SessionLog(path);
    assert.equal(reopened.diag().schemaVersion, SESSION_LOG_SCHEMA_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the query counter counts every executed statement", () => {
  const log = new SessionLog(":memory:");
  assert.equal(log.queries, 0);
  log.ensureSession("s1", at); // one INSERT OR IGNORE
  assert.equal(log.queries, 1);
  // append = ensureSession + MAX(seq) select + insert = 3 more.
  log.append("s1", { type: "user.message", producerId: "web", payload: {} }, "e1", at);
  assert.equal(log.queries, 4);
});

test("a synchronous query over the slow threshold emits a store.slow_query span (name + durationMs)", () => {
  const recorder = recordingTelemetrySink();
  // A clock that advances 200ms on every read, so each instrumented query is timed at 200ms > 100ms.
  let clock = 0;
  const slowClock = () => {
    const t = clock;
    clock += 200;
    return t;
  };
  const log = new SessionLog(":memory:", recorder.sink, slowClock);
  log.ensureSession("s1", at);

  const spans = recorder.named(SPAN_NAMES.storeSlowQuery);
  assert.ok(spans.length >= 1, "a slow query emits a store.slow_query span");
  assert.equal(log.diag().slowQueries, spans.length, "diag reports the slow-query count");
  const [span] = spans;
  assert.equal(typeof span?.attributes.query, "string", "the span names the query");
  assert.equal(span?.attributes.threshold_ms, 100);
  assert.ok((span?.durationMs ?? 0) >= 100, "the span carries the measured duration");
});

test("a fast synchronous query emits no store.slow_query span", () => {
  const recorder = recordingTelemetrySink();
  const log = new SessionLog(":memory:", recorder.sink, () => 0); // no time elapses per query
  log.ensureSession("s1", at);
  log.append("s1", { type: "user.message", producerId: "web", payload: {} }, "e1", at);
  log.inventory();
  assert.equal(recorder.named(SPAN_NAMES.storeSlowQuery).length, 0);
});
