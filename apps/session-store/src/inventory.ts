import type { InventoryRow, SessionEvent } from "@trevor/session";
import { INVENTORY_EVENT_TYPES, LIFECYCLE_TYPES } from "@trevor/session";
import type { SessionLog } from "./log";

/**
 * The session-store's in-memory inventory read model (plan 45.1, D-002). It holds one summary row per
 * session - exactly the `Omit<InventoryRow, "hostPresent">` shape `SessionLog.inventory()` projects -
 * and keeps it current WITHOUT touching SQLite on the hot path: warmed once by a single startup scan of
 * the durable log, then updated on every write (`recordAppend` on append, `ensure` on create, `remove`
 * on permanent delete). `GET /sessions` reads {@link rows} and folds in live host presence, so a 4s
 * inventory poll costs O(sessions) in memory and zero synchronous queries (the guardrail M3 asserts).
 *
 * It owns the DERIVED read model only; the durable event log and host presence are not its concern -
 * `SessionLog` owns storage, the server folds in `hub.hasLiveHost`. Because it is re-warmed from the
 * durable log on every process start, a missed update can never outlive one process lifetime: the log
 * is the source of truth, this is a cache the log rebuilds.
 *
 * {@link recordAppend} must fold each event into exactly the slot `SessionLog.projectRow` scans it into;
 * both key off the shared `INVENTORY_EVENT_TYPES` / `LIFECYCLE_TYPES` constants and a parity test pins
 * the incremental path to the full scan, so a new projected slot that misses one path is caught.
 */

/** One session's read-model row: the durable projection minus the server-folded `hostPresent`. */
type Row = Omit<InventoryRow, "hostPresent">;

// The lifecycle event types as a plain string set for membership tests (the tuple is `as const`, so a
// bare `.includes(event.type)` would fight the literal element type).
const LIFECYCLE_TYPE_SET: ReadonlySet<string> = new Set(LIFECYCLE_TYPES);

export class InventoryProjection {
  private readonly rowsById = new Map<string, Row>();

  /** Warms the read model with a single startup scan of the durable log (the one full pass; every later
   *  read is served from memory). Bounded by the M1 type index; runs off the request hot path. */
  constructor(log: Pick<SessionLog, "inventory">) {
    for (const row of log.inventory()) {
      this.rowsById.set(row.sessionId, row);
    }
  }

  /** The current read-model rows, one per session - a snapshot array, no SQLite touched. */
  rows(): Row[] {
    return [...this.rowsById.values()];
  }

  /** Creates an empty row for a freshly-created session if absent (idempotent, mirrors the store's
   *  `INSERT OR IGNORE`); `createdAt` must match the session's stored creation time. */
  ensure(sessionId: string, createdAt: string): void {
    if (!this.rowsById.has(sessionId)) {
      this.rowsById.set(sessionId, emptyRow(sessionId, createdAt));
    }
  }

  /**
   * Folds one appended event into its session's row - the incremental counterpart of a full
   * `projectRow` scan. Self-ensures the row (an append can be the event that first creates a session,
   * as the store's `append` calls `ensureSession`), then updates count/updatedAt and only the projected
   * slot the event type feeds. Must be called exactly once per durable append, in seq order.
   */
  recordAppend(event: SessionEvent): void {
    const current =
      this.rowsById.get(event.sessionId) ?? emptyRow(event.sessionId, event.createdAt);
    this.rowsById.set(event.sessionId, {
      ...current,
      eventCount: current.eventCount + 1,
      // Mirrors COALESCE(MAX(e.createdAt), s.createdAt): ISO timestamps sort lexicographically.
      updatedAt: event.createdAt > current.updatedAt ? event.createdAt : current.updatedAt,
      hostOnline: event.type === INVENTORY_EVENT_TYPES.hostOnline ? event : current.hostOnline,
      // First wins - the earliest user.message is the title source, never overwritten.
      firstUser:
        event.type === INVENTORY_EVENT_TYPES.userMessage && current.firstUser === null
          ? event
          : current.firstUser,
      lifecycle: LIFECYCLE_TYPE_SET.has(event.type)
        ? [...current.lifecycle, event]
        : current.lifecycle,
      archived: event.type === INVENTORY_EVENT_TYPES.sessionArchived ? event : current.archived,
      rename: event.type === INVENTORY_EVENT_TYPES.sessionTitle ? event : current.rename,
      deleted: event.type === INVENTORY_EVENT_TYPES.sessionDeleted ? event : current.deleted,
      forkedFrom:
        event.type === INVENTORY_EVENT_TYPES.sessionForkedFrom ? event : current.forkedFrom,
      tangentOf: event.type === INVENTORY_EVENT_TYPES.sessionTangentOf ? event : current.tangentOf,
      projectMarker:
        event.type === INVENTORY_EVENT_TYPES.sessionProject ? event : current.projectMarker,
    });
  }

  /** Drops a permanently-deleted session's row (plan 04 purge); no-op if already gone. */
  remove(sessionId: string): void {
    this.rowsById.delete(sessionId);
  }

  /** Diagnostic: how many sessions the read model holds (the read model is otherwise opaque in memory). */
  get size(): number {
    return this.rowsById.size;
  }

  /** Diagnostic: one session's current row, or undefined - for tests/ops inspection of a single entry. */
  get(sessionId: string): Row | undefined {
    return this.rowsById.get(sessionId);
  }
}

/** An empty session's row: no events, `updatedAt` = creation time, every source-event slot null - exactly
 *  what `projectRow` yields for a session with zero events (COUNT 0, COALESCE falls back to createdAt). */
function emptyRow(sessionId: string, createdAt: string): Row {
  return {
    sessionId,
    createdAt,
    updatedAt: createdAt,
    eventCount: 0,
    hostOnline: null,
    firstUser: null,
    lifecycle: [],
    archived: null,
    rename: null,
    deleted: null,
    forkedFrom: null,
    tangentOf: null,
    projectMarker: null,
  };
}
