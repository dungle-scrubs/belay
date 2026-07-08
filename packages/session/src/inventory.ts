import type { SessionEvent } from "./event";
import { decodeTrevorEvent, type GitStatus } from "./protocol";

/**
 * The session inventory read model (D-090): one distilled summary per durable session,
 * assembled by the session-store (the supervisor of the durable log) from its own DB +
 * live host-socket map. The browser consumes this read model to drive the resume chooser;
 * it never scans local state itself. Every field is derived from the durable log except
 * `host`, which folds in the store's live presence.
 */
export interface SessionSummary {
  readonly sessionId: string;
  /** First user message (truncated), or the session id when none. */
  readonly title: string;
  readonly cwd: string | null;
  readonly workspace: string | null;
  /** Base-repo name (workspace basename), used to group + sort current-project-first. */
  readonly project: string | null;
  /**
   * The canonical absolute project path (plan 58 M3): the durable `session.project` marker wins over
   * host.online workspace, then cwd. Null when none of the three are available. Drives sidebar/archive
   * grouping so it no longer depends on a live host.
   */
  readonly projectPath: string | null;
  readonly branch: string | null;
  readonly git: GitStatus | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventCount: number;
  /**
   * Host presence: "live" when a host socket is connected now; "stale" when the log shows
   * a host was here (a host.online) but none is connected; "none" when no host ever joined.
   * Distinguishing stale from none is the M1 requirement that a dead host reads differently.
   */
  readonly host: HostPresenceState;
  /** Coarse activity from the durable log: a turn in flight, settled after running, or never-ran. */
  readonly activity: SessionActivity;
  /** Whether the session is archived (D-094): hidden from the default UI/sidebar/resume views. */
  readonly archived: boolean;
  /** Whether the session is soft-deleted (sidebar Delete): hidden from EVERY view (log retained). */
  readonly deleted: boolean;
  /** Lineage: the parent this session was forked from (plan 15), or null for a root session. */
  readonly forkedFrom: SessionLineage | null;
  /**
   * Tangent lineage (plan 37): when this session is a tangent, the parent + anchor it branched from;
   * null for a normal, root, or forked session. Distinct from `forkedFrom` - a tangent is a scoped side
   * thread seeded only with the selected snapshot, kept out of ordinary top-level navigation.
   */
  readonly tangentOf: TangentAnchor | null;
}

/** A session's fork lineage: the parent it branched from and the parent seq it branched at. */
export interface SessionLineage {
  readonly parentSessionId: string;
  readonly forkSeq: number;
}

/**
 * A tangent's anchor (plan 37): the parent session + the exact source message and selected quote a
 * tangent was branched from, plus its creation time. Drives parent-owned tangent discovery (M7) and the
 * takeover's source-context header. It is metadata only - never a licence to replay parent history into
 * the tangent prompt (D-001).
 */
export interface TangentAnchor {
  readonly parentSessionId: string;
  readonly sourceMessageId: string;
  readonly quote: string;
  readonly label: string | null;
  /** The tangent's creation time (the `session.tangentOf` marker's `createdAt`). */
  readonly createdAt: string;
}

export type HostPresenceState = "live" | "stale" | "none";

/**
 * A session's coarse run state for the sidebar (D-093 M3). Three of the four are derivable from the
 * durable log - `running` (a turn in flight), `settled` (ran work, now finished), `idle` (never ran);
 * `queued` (work waiting behind the active turn) is NOT durable - the browser/host that owns the live
 * send-queue supplies it as a live override on top of the durable activity (see the session sidebar).
 */
export type SessionActivity = "running" | "queued" | "settled" | "idle";

/**
 * The raw per-session bits the store gathers before projecting a SessionSummary. Kept as
 * decoded-on-demand SessionEvents (not pre-extracted fields) so the projection logic - title,
 * cwd/workspace/git, activity - lives in one pure, testable place rather than in SQL.
 */
export interface InventoryRow {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventCount: number;
  /** The latest host.online event, if any (carries cwd/workspace/branch/git). */
  readonly hostOnline: SessionEvent | null;
  /** The earliest user.message, if any (the title source). */
  readonly firstUser: SessionEvent | null;
  /** assistant.started/assistant.completed/user.command, seq order (activity + clear reset). */
  readonly lifecycle: readonly SessionEvent[];
  /** The latest session.archived event (D-094), if any - the newest wins (archive/unarchive). */
  readonly archived: SessionEvent | null;
  /** The latest session.title rename, if any - overrides the first-prompt-derived title (newest wins). */
  readonly rename: SessionEvent | null;
  /** The latest session.deleted event (sidebar Delete), if any - the newest wins (delete/undo). */
  readonly deleted: SessionEvent | null;
  /** The session.forkedFrom lineage marker (plan 15), if this session is a fork; else null. */
  readonly forkedFrom: SessionEvent | null;
  /** The session.tangentOf lineage marker (plan 37), if this session is a tangent; else null. */
  readonly tangentOf: SessionEvent | null;
  /** The session.project marker (plan 58 M3), if any - the durable, immutable project path. */
  readonly projectMarker: SessionEvent | null;
  /** Whether a host socket is connected to this session right now. */
  readonly hostPresent: boolean;
}

const TITLE_CAP = 60;

/**
 * The session's display title: a user-set rename (latest `session.title` with non-empty text) wins;
 * otherwise the first user message (truncated); otherwise the session id. A blank rename falls back to
 * the derived title, so clearing a name reverts rather than showing an empty row.
 */
function titleFrom(
  firstUser: SessionEvent | null,
  rename: SessionEvent | null,
  sessionId: string,
): string {
  if (rename) {
    const decoded = decodeTrevorEvent(rename);
    if (decoded?.type === "session.title") {
      const renamed = decoded.title.trim().replace(/\s+/g, " ");
      if (renamed) {
        return renamed.length > TITLE_CAP ? `${renamed.slice(0, TITLE_CAP)}…` : renamed;
      }
    }
  }
  if (firstUser) {
    const decoded = decodeTrevorEvent(firstUser);
    if (decoded?.type === "user.message") {
      const text = decoded.text.trim().replace(/\s+/g, " ");
      if (text) {
        return text.length > TITLE_CAP ? `${text.slice(0, TITLE_CAP)}…` : text;
      }
    }
  }
  return sessionId;
}

/**
 * The run currently in flight, or null. The host runs one turn at a time, so only the most recent
 * run can still be active: it is in flight iff the last `assistant.started` has no matching
 * `assistant.completed`. An older started-without-completed run is a dead orphan and must not count.
 * A `/clear` resets detection so pre-clear work cannot keep a session busy.
 */
export function activeTurnRunId(lifecycle: readonly SessionEvent[]): string | null {
  const completed = new Set<string>();
  let lastStarted: string | null = null;
  for (const event of lifecycle) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    if (decoded.type === "user.command" && decoded.command === "/clear") {
      lastStarted = null;
      completed.clear();
    } else if (decoded.type === "assistant.started") {
      lastStarted = decoded.runId;
    } else if (decoded.type === "assistant.completed") {
      completed.add(decoded.runId);
    }
  }
  return lastStarted != null && !completed.has(lastStarted) ? lastStarted : null;
}

/**
 * The session's durable activity (D-093 M3): `running` when a turn is in flight, `settled` once it
 * has finished real work, or `idle` when it has never run. A `/clear` resets the detection, so a
 * freshly cleared session reads `idle` again. Pure over the lifecycle slice
 * (started/completed/command events). `queued` is not derivable here - it is layered on by the live
 * send-queue owner.
 */
export function activityFromLog(lifecycle: readonly SessionEvent[]): SessionActivity {
  let everCompleted = false;
  for (const event of lifecycle) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    if (decoded.type === "user.command" && decoded.command === "/clear") {
      everCompleted = false;
    } else if (decoded.type === "assistant.completed") {
      everCompleted = true;
    }
  }
  if (activeTurnRunId(lifecycle) !== null) {
    return "running";
  }
  return everCompleted ? "settled" : "idle";
}

function projectOf(workspace: string | null, cwd: string | null): string | null {
  const path = workspace ?? cwd;
  if (!path) {
    return null;
  }
  const trimmed = path.replace(/\/+$/, "");
  const base = trimmed.split("/").pop();
  return base && base.length > 0 ? base : trimmed;
}

/**
 * The canonical project path for a session (plan 58 M3): the durable `session.project` marker wins over
 * host.online workspace/cwd. Returns null when none of the three are available. Pure and centralized so
 * the sidebar, archive, and CLI all use one rule.
 */
export function sessionProjectPath(
  projectMarker: SessionEvent | null,
  workspace: string | null,
  cwd: string | null,
): string | null {
  if (projectMarker) {
    const decoded = decodeTrevorEvent(projectMarker);
    if (decoded?.type === "session.project" && decoded.path) {
      return decoded.path;
    }
  }
  return workspace ?? cwd ?? null;
}

/** Projects one raw inventory row into the distilled SessionSummary read model. */
export function summarizeSession(row: InventoryRow): SessionSummary {
  const host = row.hostOnline ? decodeTrevorEvent(row.hostOnline) : null;
  const online = host?.type === "host.online" ? host : null;
  const cwd = online?.cwd ?? null;
  const workspace = online?.workspace ?? null;

  const presence: HostPresenceState = row.hostPresent ? "live" : row.hostOnline ? "stale" : "none";

  const archivedEvent = row.archived ? decodeTrevorEvent(row.archived) : null;
  const archived = archivedEvent?.type === "session.archived" ? archivedEvent.archived : false;
  const deletedEvent = row.deleted ? decodeTrevorEvent(row.deleted) : null;
  const deleted = deletedEvent?.type === "session.deleted" ? deletedEvent.deleted : false;
  const forkedEvent = row.forkedFrom ? decodeTrevorEvent(row.forkedFrom) : null;
  const forkedFrom: SessionLineage | null =
    forkedEvent?.type === "session.forkedFrom"
      ? { parentSessionId: forkedEvent.parentSessionId, forkSeq: forkedEvent.forkSeq }
      : null;
  const tangentEvent = row.tangentOf ? decodeTrevorEvent(row.tangentOf) : null;
  const tangentOf: TangentAnchor | null =
    tangentEvent?.type === "session.tangentOf"
      ? {
          parentSessionId: tangentEvent.parentSessionId,
          sourceMessageId: tangentEvent.sourceMessageId,
          quote: tangentEvent.quote,
          label: tangentEvent.label ?? null,
          // The marker's own createdAt is the tangent's creation time (never duplicated in the payload).
          createdAt: row.tangentOf?.createdAt ?? row.createdAt,
        }
      : null;

  return {
    sessionId: row.sessionId,
    title: titleFrom(row.firstUser, row.rename, row.sessionId),
    cwd,
    workspace,
    project: projectOf(workspace, cwd),
    projectPath: sessionProjectPath(row.projectMarker, workspace, cwd),
    branch: online?.branch ?? null,
    git: online?.git ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    eventCount: row.eventCount,
    host: presence,
    activity: activityFromLog(row.lifecycle),
    archived,
    deleted,
    forkedFrom,
    tangentOf,
  };
}

export {
  activeSessions,
  archivedSessions,
  byRecency,
  sessionsForProject,
  sortInventory,
  tangentsOf,
} from "./inventory-display";
export { relativeTime, timeUntil } from "./time-format";
