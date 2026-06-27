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
  /** Whether a host socket is connected to this session right now. */
  readonly hostPresent: boolean;
}

const TITLE_CAP = 60;

function titleFrom(firstUser: SessionEvent | null, sessionId: string): string {
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
 * The session's durable activity (D-093 M3): `running` when a turn is in flight (the same rule as the
 * web's activeRunId - the last started run with no completion is active, an older
 * started-without-completed is a dead orphan that does not count), `settled` once it has finished real
 * work, or `idle` when it has never run. A `/clear` resets the detection, so a freshly cleared session
 * reads `idle` again. Pure over the lifecycle slice (started/completed/command events). `queued` is not
 * derivable here - it is layered on by the live send-queue owner.
 */
function deriveActivity(lifecycle: readonly SessionEvent[]): SessionActivity {
  const completed = new Set<string>();
  let lastStarted: string | null = null;
  let everCompleted = false;
  for (const event of lifecycle) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    if (decoded.type === "user.command" && decoded.command === "/clear") {
      lastStarted = null;
      completed.clear();
      everCompleted = false;
    } else if (decoded.type === "assistant.started") {
      lastStarted = decoded.runId;
    } else if (decoded.type === "assistant.completed") {
      completed.add(decoded.runId);
      everCompleted = true;
    }
  }
  if (lastStarted != null && !completed.has(lastStarted)) {
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

/** Projects one raw inventory row into the distilled SessionSummary read model. */
export function summarizeSession(row: InventoryRow): SessionSummary {
  const host = row.hostOnline ? decodeTrevorEvent(row.hostOnline) : null;
  const online = host?.type === "host.online" ? host : null;
  const cwd = online?.cwd ?? null;
  const workspace = online?.workspace ?? null;

  const presence: HostPresenceState = row.hostPresent ? "live" : row.hostOnline ? "stale" : "none";

  const archivedEvent = row.archived ? decodeTrevorEvent(row.archived) : null;
  const archived = archivedEvent?.type === "session.archived" ? archivedEvent.archived : false;

  return {
    sessionId: row.sessionId,
    title: titleFrom(row.firstUser, row.sessionId),
    cwd,
    workspace,
    project: projectOf(workspace, cwd),
    branch: online?.branch ?? null,
    git: online?.git ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    eventCount: row.eventCount,
    host: presence,
    activity: deriveActivity(row.lifecycle),
    archived,
  };
}

/**
 * The non-archived sessions (D-094): the default view for the sidebar, resume chooser, and
 * current-project navigation. Archived sessions remain in the durable store but are filtered out
 * here unless a caller explicitly wants them (e.g. an archive browser or `trevor list --archived`).
 */
export function activeSessions(summaries: readonly SessionSummary[]): SessionSummary[] {
  return summaries.filter((s) => !s.archived);
}

/** The archived sessions only (for an explicit archive filter / `trevor list --archived`). */
export function archivedSessions(summaries: readonly SessionSummary[]): SessionSummary[] {
  return summaries.filter((s) => s.archived);
}

/**
 * Orders summaries for the resume chooser: the current project's sessions first, then the
 * rest, each block by most-recent activity (updatedAt) descending. Stable + pure - takes
 * the current project name (the active session's base repo) so the browser owns the
 * "current project" notion the store can't know. Never mutates the input.
 */
export function sortInventory(
  summaries: readonly SessionSummary[],
  currentProject: string | null,
): SessionSummary[] {
  const byRecency = (a: SessionSummary, b: SessionSummary) =>
    b.updatedAt.localeCompare(a.updatedAt);
  const current = summaries.filter((s) => currentProject != null && s.project === currentProject);
  const others = summaries.filter((s) => currentProject == null || s.project !== currentProject);
  return [...current.sort(byRecency), ...others.sort(byRecency)];
}

/** A compact relative-time label from two ISO timestamps (e.g. "2h ago", "just now"). */
export function relativeTime(thenIso: string, nowMs: number): string {
  const then = Date.parse(thenIso);
  if (Number.isNaN(then)) {
    return "";
  }
  const deltaMs = Math.max(0, nowMs - then);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 45) {
    return "just now";
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  const day = Math.floor(hr / 24);
  if (day < 7) {
    return `${day}d ago`;
  }
  const wk = Math.floor(day / 7);
  if (wk <= 10) {
    return `${wk}w ago`;
  }
  // Past ~10 weeks the relative label stops growing and switches to a specific date (D-093): an
  // ever-larger week count reads worse than a date, and a "months ago" label is never rendered.
  // Formatted from the timestamp in UTC so it is deterministic regardless of the viewer's timezone.
  const d = new Date(then);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
