import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InventoryRow, PublishInput, SessionEvent, StreamEnvelope } from "@trevor/session";
import { frames, INVENTORY_EVENT_TYPES, LIFECYCLE_TYPES } from "@trevor/session";
import {
  NOOP_SINK,
  SPAN_NAMES,
  safeAttributes,
  safeEmitSpan,
  type TelemetrySink,
  withSpanSync,
} from "@trevor/session/telemetry";

/**
 * The local session log on SQLite (the durable substrate for local-mode sessions,
 * the standalone equivalent of Tether). It owns an append-only, per-session,
 * monotonically-sequenced event stream - the same shape every participant replays
 * - kept free of HTTP/WebSocket so it is directly testable; the server in `main.ts`
 * is a thin transport over it.
 *
 * One row per event, keyed by (sessionId, seq). seq is assigned here as
 * MAX(seq)+1 per session inside a single synchronous call, so it is dense and
 * gap-free with no races (node:sqlite is synchronous; one append never interleaves
 * with another). WAL mode lets a reader replay while a writer appends.
 */

// A stored event is the shared SessionEvent, and the fields a publisher supplies
// are PublishInput - both owned by @trevor/session (the event shape is the
// contract; the log assigns seq/eventId/createdAt). EventRow below is the
// genuinely private SQLite row (payload is a JSON string on disk).

interface EventRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly eventId: string;
  readonly type: string;
  readonly producerId: string;
  readonly payload: string;
  readonly createdAt: string;
}

/** The per-session aggregate (count + bounds) the inventory projection is built from. */
interface AggregateRow {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly eventCount: number;
  readonly updatedAt: string;
}

export interface SessionLogDiag {
  readonly indexHealthy: boolean;
  readonly queries: number;
  readonly schemaVersion: number;
  readonly slowQueries: number;
  readonly startupSha: string | null;
}

type GitRunner = (args: readonly string[]) => {
  readonly status: number | null;
  readonly stdout: string;
};

/** The full event column list every row-returning read selects, in `EventRow` order. Shared so the
 *  replay/type-lookup reads and the query-plan diagnostic all speak the exact same projection. */
const EVENT_COLUMNS = "sessionId, seq, eventId, type, producerId, payload, createdAt";

const TYPE_LOOKUP_INDEX = "events_session_type_seq";

/** The per-session "latest/first event of a type" lookup (`ORDER BY seq DESC/ASC LIMIT 1`). Shared by
 *  `latestOfType`/`firstOfType` and the `explainTypeLookup` diagnostic so the query-plan guardrail always
 *  explains the exact statement the hot path runs - it can't pass while the real query silently drifts. */
const typeLookupSql = (order: "ASC" | "DESC"): string =>
  `SELECT ${EVENT_COLUMNS} FROM events WHERE sessionId = ? AND type = ? ORDER BY seq ${order} LIMIT 1`;

/**
 * The slow-query threshold (plan 45.1 M3, D-004): a single synchronous store query taking longer than
 * this blocks the event loop for that long (node:sqlite is synchronous on the one thread), so crossing
 * it emits a `store.slow_query` span. 100ms is well above a healthy indexed lookup yet far below the
 * ~1.67s scan 45.1 removed, so the signal marks a real regression, not routine work.
 */
const SLOW_QUERY_MS = 100;
export const SESSION_LOG_SCHEMA_VERSION = 1;

/** A node-backed git runner scoped to `cwd`, using argv arrays with no shell parsing. */
function nodeGitRunner(cwd: string): GitRunner {
  return (args) => {
    const out = spawnSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { status: out.status, stdout: typeof out.stdout === "string" ? out.stdout : "" };
  };
}

/** The git HEAD at store startup, or null when the process is not in a git checkout. */
function readStartupSha(cwd = process.cwd()): string | null {
  const out = nodeGitRunner(cwd)(["rev-parse", "HEAD"]);
  const sha = out.status === 0 ? out.stdout.trim() : "";
  return sha || null;
}

function typeLookupPlanIsHealthy(plan: string): boolean {
  const upper = plan.toUpperCase();
  return (
    /\bSEARCH\b.*\bUSING\b(?:\s+\w+)*\s+INDEX\s+EVENTS_SESSION_TYPE_SEQ\b/.test(upper) &&
    !/\bSCAN\b/.test(upper) &&
    !upper.includes("TEMP B-TREE")
  );
}

/** Maps a private SQLite row (payload as a JSON string) into the shared SessionEvent shape. */
function rowToEvent(r: EventRow): SessionEvent {
  return {
    sessionId: r.sessionId,
    seq: Number(r.seq),
    eventId: r.eventId,
    type: r.type,
    producerId: r.producerId,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    createdAt: r.createdAt,
  };
}

export class SessionLog {
  private readonly db: DatabaseSync;

  /** Monotonically increasing count of SQLite statements executed - see {@link queries}. */
  private queryCount = 0;

  /** Monotonically increasing count of statements that crossed the slow-query threshold. */
  private slowQueryCount = 0;

  /** Opens (creating if absent) the SQLite log at `path`, or `:memory:` for tests. Telemetry is off by
   *  default (NOOP_SINK); the append span carries only the event type, never the session id or payload.
   *  `now` is injectable so the slow-query timing (M3) is deterministic in tests. */
  constructor(
    path: string,
    private readonly sink: TelemetrySink = NOOP_SINK,
    private readonly now: () => number = Date.now,
    private readonly startupSha: string | null = readStartupSha(),
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         sessionId TEXT PRIMARY KEY,
         createdAt TEXT NOT NULL
       );`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS events (
         sessionId  TEXT    NOT NULL,
         seq        INTEGER NOT NULL,
         eventId    TEXT    NOT NULL,
         type       TEXT    NOT NULL,
         producerId TEXT    NOT NULL,
         payload    TEXT    NOT NULL,
         createdAt  TEXT    NOT NULL,
         PRIMARY KEY (sessionId, seq)
       );`,
    );
    // The inventory read model projects a handful of per-session, per-type events (latest host.online,
    // first user.message, the lifecycle slice, the archive/title/delete/lineage markers). Column order
    // matters: (sessionId, type) are the equality predicates, so an index leading with them turns each
    // lookup into a direct seek; trailing `seq` then hands back seq order for free, so ORDER BY seq needs
    // no filesort. The PK (sessionId, seq) alone can only seek sessionId, then scans + filters by type.
    // `IF NOT EXISTS` so reopening the (large, already-populated) live DB is a no-op, never a rebuild.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS ${TYPE_LOOKUP_INDEX} ON events(sessionId, type, seq);`,
    );
    this.migrateSchemaVersion();
  }

  /**
   * How many SQLite statements this log has executed (plan 45.1 M3): the guardrail counter. `GET /sessions`
   * is served from the in-memory projection, so a test snapshots this before/after an inventory poll and
   * asserts it stays flat - proving no request path quietly reintroduced a per-poll scan of the log.
   */
  get queries(): number {
    return this.queryCount;
  }

  /**
   * The single instrumentation seam every SQLite read/write in this class runs through (D-004): it bumps
   * {@link queries} and times the call, emitting a `store.slow_query` span (query name + durationMs) when
   * one synchronous query crosses {@link SLOW_QUERY_MS}. Centralizing it here is the transport-isolation
   * guardrail - the event loop can't be monopolized by an unmeasured store query, and a regression shows
   * up as a slow-query span rather than a silent stall. `name` is a fixed, low-cardinality query label.
   */
  private query<T>(name: string, run: () => T): T {
    this.queryCount += 1;
    const startedAt = this.now();
    const result = run();
    const durationMs = this.now() - startedAt;
    if (durationMs > SLOW_QUERY_MS) {
      this.slowQueryCount += 1;
      safeEmitSpan(this.sink, {
        name: SPAN_NAMES.storeSlowQuery,
        attributes: safeAttributes({ query: name, threshold_ms: SLOW_QUERY_MS }),
        status: "ok",
        durationMs,
      });
    }
    return result;
  }

  /** Creates the session if absent (idempotent); returns its id either way. */
  ensureSession(sessionId: string, nowIso: string): string {
    this.query("ensureSession", () =>
      this.db
        .prepare("INSERT OR IGNORE INTO sessions (sessionId, createdAt) VALUES (?, ?)")
        .run(sessionId, nowIso),
    );
    return sessionId;
  }

  /** Appends one event, assigning the next per-session seq; returns the stored row. */
  append(sessionId: string, input: PublishInput, eventId: string, nowIso: string): SessionEvent {
    return withSpanSync(
      this.sink,
      SPAN_NAMES.storeAppend,
      { event_type: input.type, producer: input.producerId },
      () => {
        this.ensureSession(sessionId, nowIso);
        const row = this.query(
          "append.maxSeq",
          () =>
            this.db
              .prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM events WHERE sessionId = ?")
              .get(sessionId) as { maxSeq: number },
        );
        const seq = Number(row.maxSeq) + 1;
        const payload = JSON.stringify(input.payload ?? {});
        this.query("append.insert", () =>
          this.db
            .prepare(
              `INSERT INTO events (sessionId, seq, eventId, type, producerId, payload, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(sessionId, seq, eventId, input.type, input.producerId, payload, nowIso),
        );
        return {
          sessionId,
          seq,
          eventId,
          type: input.type,
          producerId: input.producerId,
          payload: input.payload ?? {},
          createdAt: nowIso,
        };
      },
    );
  }

  /**
   * The raw inventory rows (D-090), one per session: aggregate counts/timestamps plus the
   * few events the read model projects from - the latest host.online (cwd/workspace/git),
   * the first user.message (title), and the lifecycle slice (activity). `hostPresent` is
   * left false here; the server folds in its live-socket map. Bounded per session (a handful
   * of targeted, now-indexed queries), never a full-log scan.
   *
   * Boundary (plan 45.1): this is the STARTUP-WARM/parity path, not the hot path. `GET /sessions`
   * is served from the derived {@link InventoryProjection} (in `inventory.ts`), which this method
   * warms once at process start and which the parity test pins against; the durable log owns storage,
   * the projection owns the live read model. Calling this per request is exactly the scan 45.1 removed.
   */
  inventory(): Omit<InventoryRow, "hostPresent">[] {
    const sessions = this.query(
      "inventory.aggregate",
      () =>
        this.db
          .prepare(
            `SELECT s.sessionId AS sessionId,
                s.createdAt  AS createdAt,
                COUNT(e.seq) AS eventCount,
                COALESCE(MAX(e.createdAt), s.createdAt) AS updatedAt
           FROM sessions s
           LEFT JOIN events e ON e.sessionId = s.sessionId
          GROUP BY s.sessionId, s.createdAt`,
          )
          .all() as unknown as AggregateRow[],
    );
    return sessions.map((s) => this.projectRow(s));
  }

  /**
   * One session's inventory row, or null if it doesn't exist - the single-session form of `inventory()`
   * for callers that need exactly one summary (the permanent-delete gate) instead of scanning every
   * session. Same projection, scoped by `sessionId` (bounded queries, no full-log/whole-table pass).
   */
  summaryRow(sessionId: string): Omit<InventoryRow, "hostPresent"> | null {
    const s = this.query(
      "summaryRow.aggregate",
      () =>
        this.db
          .prepare(
            `SELECT s.sessionId AS sessionId,
                s.createdAt  AS createdAt,
                COUNT(e.seq) AS eventCount,
                COALESCE(MAX(e.createdAt), s.createdAt) AS updatedAt
           FROM sessions s
           LEFT JOIN events e ON e.sessionId = s.sessionId
          WHERE s.sessionId = ?
          GROUP BY s.sessionId, s.createdAt`,
          )
          .get(sessionId) as AggregateRow | undefined,
    );
    return s ? this.projectRow(s) : null;
  }

  /** Projects one aggregate row into the inventory read model's per-session shape (the few events the
   *  read model needs, each a bounded per-session lookup). `hostPresent` is the server's to fold in. */
  private projectRow(s: AggregateRow): Omit<InventoryRow, "hostPresent"> {
    return {
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      eventCount: Number(s.eventCount),
      hostOnline: this.latestOfType(s.sessionId, INVENTORY_EVENT_TYPES.hostOnline),
      firstUser: this.firstOfType(s.sessionId, INVENTORY_EVENT_TYPES.userMessage),
      lifecycle: this.eventsOfTypes(s.sessionId, LIFECYCLE_TYPES),
      archived: this.latestOfType(s.sessionId, INVENTORY_EVENT_TYPES.sessionArchived),
      rename: this.latestOfType(s.sessionId, INVENTORY_EVENT_TYPES.sessionTitle),
      deleted: this.latestOfType(s.sessionId, INVENTORY_EVENT_TYPES.sessionDeleted),
      forkedFrom: this.latestOfType(s.sessionId, INVENTORY_EVENT_TYPES.sessionForkedFrom),
      tangentOf: this.latestOfType(s.sessionId, INVENTORY_EVENT_TYPES.sessionTangentOf),
    };
  }

  /**
   * Permanently removes a session and all its events (plan 04); returns whether a session row was
   * removed (from the DELETE's own change count - no separate existence probe). This is the destructive
   * purge - distinct from the soft-delete `session.deleted` marker, which only hides a session while
   * retaining its log. Eligibility (archived, not active) is the caller's gate; this just deletes. The
   * rows are gone from the SQLite file, so the session never reappears after reload/reconnect.
   */
  deleteSession(sessionId: string): boolean {
    this.query("deleteSession.events", () =>
      this.db.prepare("DELETE FROM events WHERE sessionId = ?").run(sessionId),
    );
    return (
      this.query("deleteSession.session", () =>
        this.db.prepare("DELETE FROM sessions WHERE sessionId = ?").run(sessionId),
      ).changes > 0
    );
  }

  /** The most recent event of a type in a session, or null. */
  private latestOfType(sessionId: string, type: string): SessionEvent | null {
    const row = this.query(
      "latestOfType",
      () => this.db.prepare(typeLookupSql("DESC")).get(sessionId, type) as EventRow | undefined,
    );
    return row ? rowToEvent(row) : null;
  }

  /** The earliest event of a type in a session, or null. */
  private firstOfType(sessionId: string, type: string): SessionEvent | null {
    const row = this.query(
      "firstOfType",
      () => this.db.prepare(typeLookupSql("ASC")).get(sessionId, type) as EventRow | undefined,
    );
    return row ? rowToEvent(row) : null;
  }

  /** All events of the given types in a session, in seq order. */
  private eventsOfTypes(sessionId: string, types: readonly string[]): SessionEvent[] {
    const placeholders = types.map(() => "?").join(", ");
    const rows = this.query(
      "eventsOfTypes",
      () =>
        this.db
          .prepare(
            `SELECT ${EVENT_COLUMNS}
           FROM events WHERE sessionId = ? AND type IN (${placeholders}) ORDER BY seq ASC`,
          )
          .all(sessionId, ...types) as unknown as EventRow[],
    );
    return rows.map(rowToEvent);
  }

  /**
   * Diagnostic (M1): the query plan SQLite chooses for the per-session type lookup (`latestOfType`),
   * joined into one line. A test asserts it SEEKs `events_session_type_seq` with no `TEMP B-TREE`
   * sort - i.e. a direct `(sessionId, type)` index seek with seq order free from the index, rather
   * than scanning the whole session's history and sorting. Off the hot path (tests/ops only).
   */
  explainTypeLookup(): string {
    const rows = this.db
      .prepare(`EXPLAIN QUERY PLAN ${typeLookupSql("DESC")}`)
      .all("s", "t") as unknown as { detail: string }[];
    return rows.map((r) => r.detail).join("; ");
  }

  /**
   * Diagnostic self-check for the store's drift-sensitive substrate. This stays off the request hot path:
   * it explains the exact type lookup used by inventory warmup, reads SQLite's `user_version`, and reports
   * the process-start git SHA so the host doctor can spot a stale running store.
   */
  diag(): SessionLogDiag {
    return {
      // Gate on a FRESH sqlite_master read, not the cached query plan alone: a long-lived connection
      // caches the plan it compiled, so an index dropped/created at runtime (the drift this check exists
      // to catch) is invisible to EXPLAIN but always shows in sqlite_master. The plan check still guards
      // against a present-but-unused index (stats degradation); both agree in production, where the index
      // is created once at startup and never changes under the live connection.
      indexHealthy: this.hasTypeIndex() && typeLookupPlanIsHealthy(this.explainTypeLookup()),
      queries: this.queryCount,
      schemaVersion: this.readSchemaVersion(),
      slowQueries: this.slowQueryCount,
      startupSha: this.startupSha,
    };
  }

  /** Whether the hot-lookup index physically exists right now (a fresh sqlite_master read, so a runtime
   *  drop/create is seen even when the connection's cached EXPLAIN plan is stale). */
  private hasTypeIndex(): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'events_session_type_seq'",
      )
      .get() as { readonly present?: number } | undefined;
    return row?.present === 1;
  }

  private readSchemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { readonly user_version?: number }
      | undefined;
    return Number(row?.user_version ?? 0);
  }

  private migrateSchemaVersion(): void {
    if (this.readSchemaVersion() < SESSION_LOG_SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SESSION_LOG_SCHEMA_VERSION};`);
    }
  }

  /** Every event for a session with seq > afterSeq, in seq order (the replay). */
  readAfter(sessionId: string, afterSeq: number): SessionEvent[] {
    const rows = this.query(
      "readAfter",
      () =>
        this.db
          .prepare(
            `SELECT ${EVENT_COLUMNS}
           FROM events WHERE sessionId = ? AND seq > ? ORDER BY seq ASC`,
          )
          .all(sessionId, afterSeq) as unknown as EventRow[],
    );
    return rows.map(rowToEvent);
  }

  /**
   * The replay (seq > afterSeq) as ready-to-send WIRE FRAMES, in seq order. The log owns the
   * wire framing (D-023): it wraps each replayed event in the `event` frame so the server can
   * fan out the result verbatim without knowing the frame schema. Frame/schema changes localize
   * here rather than leaking to the transport.
   */
  readFrames(sessionId: string, afterSeq: number): StreamEnvelope[] {
    return this.readAfter(sessionId, afterSeq).map((event) => frames.event(event));
  }
}
