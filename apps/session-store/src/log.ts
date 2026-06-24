import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

/** One stored event, matching the shared SessionEvent shape participants decode. */
export interface StoredEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly eventId: string;
  readonly type: string;
  readonly producerId: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

/** The fields a publisher supplies; the log assigns seq/eventId/createdAt. */
export interface AppendInput {
  readonly type: string;
  readonly producerId: string;
  readonly payload: Record<string, unknown>;
}

interface EventRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly eventId: string;
  readonly type: string;
  readonly producerId: string;
  readonly payload: string;
  readonly createdAt: string;
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
  append(sessionId: string, input: AppendInput, eventId: string, nowIso: string): StoredEvent {
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

  /** Every event for a session with seq > afterSeq, in seq order (the replay). */
  readAfter(sessionId: string, afterSeq: number): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT sessionId, seq, eventId, type, producerId, payload, createdAt
           FROM events WHERE sessionId = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(sessionId, afterSeq) as unknown as EventRow[];
    return rows.map((r) => ({
      sessionId: r.sessionId,
      seq: Number(r.seq),
      eventId: r.eventId,
      type: r.type,
      producerId: r.producerId,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      createdAt: r.createdAt,
    }));
  }
}
