import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { frames } from "@belay/session";
import { NOOP_SINK, SPAN_NAMES } from "@belay/session/telemetry";
import { recordingTelemetrySink, tempDir } from "@belay/test-kit";
import { test } from "vitest";
import {
  BREAKER_COOLDOWN_MS,
  QUERY_BUDGET_MS,
  SESSION_LOG_SCHEMA_VERSION,
  SessionLog,
  StoreCircuitOpenError,
} from "./log";

const at = "2026-06-24T00:00:00.000Z";

/** A hand-cranked clock for the breaker tests: each `now()` read returns the current time then advances
 *  it by `step` (query() reads it twice, so one measured query spans exactly `step` ms), and `advance`
 *  jumps the clock to elapse a cooldown without executing any query. */
function testClock() {
  let time = 0;
  let step = 0;
  return {
    now: () => {
      const value = time;
      time += step;
      return value;
    },
    setStep: (ms: number) => {
      step = ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

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
  const dir = tempDir("belay-diag-");
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
  const dir = tempDir("belay-index-");
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
  const dir = tempDir("belay-user-version-");
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

// ---------------------------------------------------------------------------
// Plan 45.2 M3 - the circuit breaker over the bounded-query policy.
// ---------------------------------------------------------------------------

test("A-001 spike: node:sqlite's vdbeOp limit caps compiled program size at prepare - it cannot abort runtime scan work", () => {
  const dir = tempDir("belay-vdbe-spike-");
  const path = join(dir, "spike.db");
  try {
    // Populate uncapped: 20k rows, enough that a full scan does real runtime work.
    const setup = new DatabaseSync(path);
    setup.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)");
    setup.exec("BEGIN");
    const insert = setup.prepare("INSERT INTO t (a) VALUES (?)");
    for (let i = 0; i < 20_000; i += 1) {
      insert.run(i);
    }
    setup.exec("COMMIT");
    setup.close();

    // The API half of A-001 holds: the cap is settable at construction and readable at runtime.
    const db = new DatabaseSync(path, { limits: { vdbeOp: 60 } });
    try {
      assert.equal(db.limits.vdbeOp, 60);

      // The cap acts at PREPARE: a statement whose compiled program exceeds it is rejected up front
      // (SQLITE_NOMEM surfaced as ERR_SQLITE_ERROR "out of memory")...
      const wide = `SELECT ${Array.from({ length: 80 }, (_, i) => `a + ${i}`).join(", ")} FROM t WHERE id = 1`;
      assert.throws(
        () => db.prepare(wide),
        (error: unknown) => (error as { code?: string }).code === "ERR_SQLITE_ERROR",
        "an over-cap compiled program is rejected at prepare",
      );

      // ...while an indexed point lookup compiles under it and runs fine...
      const point = db.prepare("SELECT a FROM t WHERE id = 12345").get() as { a: number };
      assert.equal(point.a, 12344);

      // ...and the case M3 needed FAILS: a full scan compiles to a tiny looping program, so all 20k
      // rows of runtime work COMPLETE under the 60-op cap. vdbeOp is SQLITE_LIMIT_VDBE_OP - a
      // prepare-time bound on program LENGTH, not an executed-opcode budget - so it can never abort
      // the wedge-class scan (2026-07-06). A-001 is REJECTED: the seam is breaker-only, per the
      // plan's escape hatch, and the M2 watchdog is the backstop for a query already mid-flight.
      const scan = db.prepare("SELECT COUNT(*) AS n FROM t WHERE a % 7 = 3").get() as { n: number };
      assert.equal(scan.n, 2857, "the full scan ran to completion despite the tiny cap");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the breaker opens on an over-budget query, fast-fails during the cooldown, then a half-open probe closes it", () => {
  const recorder = recordingTelemetrySink();
  const clock = testClock();
  const log = new SessionLog(":memory:", recorder.sink, clock.now, null);
  log.append("s1", { type: "user.message", producerId: "web", payload: {} }, "e1", at);

  // One over-budget query trips the breaker; post-slow-query policy: it still returns its result.
  clock.setStep(QUERY_BUDGET_MS + 100);
  assert.equal(log.readAfter("s1", 0).length, 1, "the tripping query itself completes");
  clock.setStep(0);

  const opens = recorder.named(SPAN_NAMES.storeCircuitOpen);
  assert.equal(opens.length, 1, "the trip emits one circuit_open span");
  assert.equal(opens[0]?.attributes.query, "readAfter", "the span names the triggering query");
  assert.equal(opens[0]?.attributes.budget_ms, QUERY_BUDGET_MS);
  assert.equal(opens[0]?.attributes.cooldown_ms, BREAKER_COOLDOWN_MS);
  assert.ok((opens[0]?.durationMs ?? 0) > QUERY_BUDGET_MS, "the span carries the slow duration");

  // During the cooldown every operation fast-fails typed - without ever reaching SQLite.
  const queriesBefore = log.queries;
  assert.throws(
    () => log.readAfter("s1", 0),
    (error: unknown) =>
      error instanceof StoreCircuitOpenError &&
      error.sinceQuery === "readAfter" &&
      error.retryAfterMs > 0 &&
      error.retryAfterMs <= BREAKER_COOLDOWN_MS,
    "reads fast-fail with the typed breaker error",
  );
  assert.equal(log.queries, queriesBefore, "a fast-fail executes zero statements");

  // The drift/health surface is deliberately ungated: /diag keeps answering while the circuit is open.
  assert.equal(log.diag().indexHealthy, true);

  // After the cooldown the next operation is the single half-open probe; in budget, it closes the circuit.
  clock.advance(BREAKER_COOLDOWN_MS);
  assert.equal(log.readAfter("s1", 0).length, 1, "the half-open probe runs and returns");
  const closes = recorder.named(SPAN_NAMES.storeCircuitClosed);
  assert.equal(closes.length, 1, "closing emits one circuit_closed span");
  assert.equal(
    closes[0]?.attributes.query,
    "readAfter",
    "the close span names the query that tripped",
  );
  assert.ok(
    (closes[0]?.durationMs ?? 0) >= BREAKER_COOLDOWN_MS,
    "the close span carries the total open duration",
  );
  assert.equal(log.readAfter("s1", 0).length, 1, "the circuit is genuinely closed again");
});

test("an over-budget half-open probe re-opens the circuit for a fresh cooldown", () => {
  const recorder = recordingTelemetrySink();
  const clock = testClock();
  const log = new SessionLog(":memory:", recorder.sink, clock.now, null);
  log.append("s1", { type: "user.message", producerId: "web", payload: {} }, "e1", at);

  clock.setStep(QUERY_BUDGET_MS + 100);
  log.readAfter("s1", 0); // trips
  clock.setStep(0);
  clock.advance(BREAKER_COOLDOWN_MS);

  // The probe itself is over budget: it completes (post-slow-query policy) but re-opens the circuit.
  clock.setStep(QUERY_BUDGET_MS + 100);
  assert.equal(log.readAfter("s1", 0).length, 1);
  clock.setStep(0);

  assert.equal(
    recorder.named(SPAN_NAMES.storeCircuitOpen).length,
    2,
    "the failed probe emits a second circuit_open",
  );
  assert.equal(
    recorder.named(SPAN_NAMES.storeCircuitClosed).length,
    0,
    "a failed probe never closes the circuit",
  );
  assert.throws(() => log.readAfter("s1", 0), StoreCircuitOpenError);
});

test("the startup warm scan is breaker-exempt: an over-budget cold inventory() never opens the circuit", () => {
  const recorder = recordingTelemetrySink();
  const clock = testClock();
  const log = new SessionLog(":memory:", recorder.sink, clock.now, null);
  log.append("s1", { type: "user.message", producerId: "web", payload: {} }, "e1", at);

  // The cold warm scan (what InventoryProjection's constructor runs at boot): every statement far
  // over budget - the wedge-class DB whose scans ran ~1.67s. Observed, never acted on.
  clock.setStep(QUERY_BUDGET_MS + 700);
  const rows = log.inventory();
  clock.setStep(0);
  assert.equal(rows.length, 1, "the warm scan still returns its rows");
  assert.ok(
    recorder.named(SPAN_NAMES.storeSlowQuery).length >= 1,
    "the slow warm scan is still observed as store.slow_query",
  );
  assert.equal(
    recorder.named(SPAN_NAMES.storeCircuitOpen).length,
    0,
    "the warm scan never emits circuit_open",
  );

  // The regression this pins: the first real write after boot is admitted, not 503'd for a cooldown.
  const stored = log.append(
    "s1",
    { type: "user.message", producerId: "web", payload: {} },
    "e2",
    at,
  );
  assert.equal(stored.seq, 2, "the first post-boot write succeeds immediately");
});

test("a tripped breaker rejects a write BEFORE any mutation - nothing durable, no seq consumed, dense after recovery", () => {
  const dir = tempDir("belay-breaker-write-");
  const path = join(dir, "sessions.db");
  try {
    const clock = testClock();
    const log = new SessionLog(path, NOOP_SINK, clock.now, null);
    log.append("s1", { type: "user.message", producerId: "web", payload: {} }, "e1", at); // seq 1

    clock.setStep(QUERY_BUDGET_MS + 100);
    log.readAfter("s1", 0); // a slow READ trips the breaker
    clock.setStep(0);

    // Every write entrypoint fast-fails typed, and no statement reaches SQLite.
    const queriesBefore = log.queries;
    assert.throws(
      () => log.append("s2", { type: "user.message", producerId: "web", payload: {} }, "e2", at),
      StoreCircuitOpenError,
    );
    assert.throws(() => log.ensureSession("s2", at), StoreCircuitOpenError);
    assert.throws(() => log.deleteSession("s1"), StoreCircuitOpenError);
    assert.equal(log.queries, queriesBefore, "a rejected write executes zero statements");

    // An independent connection proves the rejected writes left NOTHING half-applied in the durable log.
    const raw = new DatabaseSync(path);
    const sessions = raw
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE sessionId = 's2'")
      .get() as { n: number };
    const events = raw.prepare("SELECT COUNT(*) AS n FROM events WHERE sessionId = 's2'").get() as {
      n: number;
    };
    const s1Events = raw
      .prepare("SELECT COUNT(*) AS n FROM events WHERE sessionId = 's1'")
      .get() as { n: number };
    raw.close();
    assert.equal(sessions.n, 0, "the rejected append/ensure wrote no session row");
    assert.equal(events.n, 0, "the rejected append wrote no event row");
    assert.equal(s1Events.n, 1, "the rejected delete removed nothing");

    // After the cooldown the write succeeds and MAX(seq)+1 is intact: seq stays dense, no gap.
    clock.advance(BREAKER_COOLDOWN_MS);
    const next = log.append(
      "s1",
      { type: "user.message", producerId: "web", payload: {} },
      "e3",
      at,
    );
    assert.equal(next.seq, 2, "seq is dense - the rejected write consumed no seq");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a trip during an admitted write never half-applies it: the write completes, only the NEXT operation fast-fails", () => {
  const clock = testClock();
  const log = new SessionLog(":memory:", NOOP_SINK, clock.now, null);

  // Every statement of this append is over budget: the FIRST one trips the breaker, but the already-
  // admitted write still runs to completion (admission is per operation, never mid-operation) - the
  // alternative would strand a durable session row with no event row and no read-model entry.
  clock.setStep(QUERY_BUDGET_MS + 100);
  const stored = log.append(
    "s1",
    { type: "user.message", producerId: "web", payload: {} },
    "e1",
    at,
  );
  clock.setStep(0);
  assert.equal(stored.seq, 1, "the admitted write fully applied");

  assert.throws(() => log.readAfter("s1", 0), StoreCircuitOpenError);

  clock.advance(BREAKER_COOLDOWN_MS);
  assert.deepEqual(
    log.readAfter("s1", 0).map((e) => e.seq),
    [1],
    "the durable log holds exactly the completed write",
  );
});
