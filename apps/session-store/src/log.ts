import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InventoryRow, PublishInput, SessionEvent } from "@trevor/session";

/** The lifecycle event types the inventory reads for the per-session activity signal. */
const LIFECYCLE_TYPES = ["assistant.started", "assistant.completed", "user.command"] as const;

/**
 * The local session log on SQLite (the durable substrate for local-mode sessions,
 * the standalone equivalent of Richter). It owns an append-only, per-session,
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

  /** Opens (creating if absent) the SQLite log at `path`, or `:memory:` for tests. */
  constructor(path: string) {
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
  }

  /** Creates the session if absent (idempotent); returns its id either way. */
  ensureSession(sessionId: string, nowIso: string): string {
    this.db
      .prepare("INSERT OR IGNORE INTO sessions (sessionId, createdAt) VALUES (?, ?)")
      .run(sessionId, nowIso);
    return sessionId;
  }

  /** Appends one event, assigning the next per-session seq; returns the stored row. */
  append(sessionId: string, input: PublishInput, eventId: string, nowIso: string): SessionEvent {
    this.ensureSession(sessionId, nowIso);
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM events WHERE sessionId = ?")
      .get(sessionId) as { maxSeq: number };
    const seq = Number(row.maxSeq) + 1;
    const payload = JSON.stringify(input.payload ?? {});
    this.db
      .prepare(
        `INSERT INTO events (sessionId, seq, eventId, type, producerId, payload, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, seq, eventId, input.type, input.producerId, payload, nowIso);
    return {
      sessionId,
      seq,
      eventId,
      type: input.type,
      producerId: input.producerId,
      payload: input.payload ?? {},
      createdAt: nowIso,
    };
  }

  /**
   * The raw inventory rows (D-090), one per session: aggregate counts/timestamps plus the
   * few events the read model projects from - the latest host.online (cwd/workspace/git),
   * the first user.message (title), and the lifecycle slice (activity). `hostPresent` is
   * left false here; the server folds in its live-socket map. Bounded per session (a handful
   * of targeted queries), never a full-log scan.
   */
  inventory(): Omit<InventoryRow, "hostPresent">[] {
    const sessions = this.db
      .prepare(
        `SELECT s.sessionId AS sessionId,
                s.createdAt  AS createdAt,
                COUNT(e.seq) AS eventCount,
                COALESCE(MAX(e.createdAt), s.createdAt) AS updatedAt
           FROM sessions s
           LEFT JOIN events e ON e.sessionId = s.sessionId
          GROUP BY s.sessionId, s.createdAt`,
      )
      .all() as unknown as {
      sessionId: string;
      createdAt: string;
      eventCount: number;
      updatedAt: string;
    }[];

    return sessions.map((s) => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      eventCount: Number(s.eventCount),
      hostOnline: this.latestOfType(s.sessionId, "host.online"),
      firstUser: this.firstOfType(s.sessionId, "user.message"),
      lifecycle: this.eventsOfTypes(s.sessionId, LIFECYCLE_TYPES),
    }));
  }

  /** The most recent event of a type in a session, or null. */
  private latestOfType(sessionId: string, type: string): SessionEvent | null {
    const row = this.db
      .prepare(
        `SELECT sessionId, seq, eventId, type, producerId, payload, createdAt
           FROM events WHERE sessionId = ? AND type = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId, type) as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  /** The earliest event of a type in a session, or null. */
  private firstOfType(sessionId: string, type: string): SessionEvent | null {
    const row = this.db
      .prepare(
        `SELECT sessionId, seq, eventId, type, producerId, payload, createdAt
           FROM events WHERE sessionId = ? AND type = ? ORDER BY seq ASC LIMIT 1`,
      )
      .get(sessionId, type) as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  /** All events of the given types in a session, in seq order. */
  private eventsOfTypes(sessionId: string, types: readonly string[]): SessionEvent[] {
    const placeholders = types.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT sessionId, seq, eventId, type, producerId, payload, createdAt
           FROM events WHERE sessionId = ? AND type IN (${placeholders}) ORDER BY seq ASC`,
      )
      .all(sessionId, ...types) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  /** Every event for a session with seq > afterSeq, in seq order (the replay). */
  readAfter(sessionId: string, afterSeq: number): SessionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT sessionId, seq, eventId, type, producerId, payload, createdAt
           FROM events WHERE sessionId = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(sessionId, afterSeq) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }
}
