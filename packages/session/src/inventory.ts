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
  /** Coarse activity from the durable log: a turn in flight vs settled. */
  readonly activity: SessionActivity;
}

export type HostPresenceState = "live" | "stale" | "none";
export type SessionActivity = "running" | "idle";

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
 * Whether the session has a turn in flight, by the same rule as the web's activeRunId: the
 * last started run with no completion is active, an older started-without-completed is a
 * dead orphan that does not count, and a `/clear` resets the detection. Pure over the
 * lifecycle slice (started/completed/command events).
 */
function runActive(lifecycle: readonly SessionEvent[]): boolean {
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
  return lastStarted != null && !completed.has(lastStarted);
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
    activity: runActive(row.lifecycle) ? "running" : "idle",
  };
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
  return `${wk}w ago`;
}
