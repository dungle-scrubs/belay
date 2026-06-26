import {
  activeSessions,
  archivedSessions,
  relativeTime,
  type SessionSummary,
} from "@trevor/session";

/**
 * The `trevor` session-lifecycle subcommands (D-094 M3): list current-project sessions (active by
 * default, archived with `--archived`), and archive / unarchive a session by id. The list filtering
 * + rendering and the command flow are pure over an injected {@link LifecycleIo}, so they are
 * unit-tested without a running store; `main.ts` supplies the real HTTP/transport IO.
 */

export interface LifecycleIo {
  /** The durable store's inventory (GET /sessions). */
  readonly fetchSessions: () => Promise<readonly SessionSummary[]>;
  /** Publishes a session.archived marker (POST /sessions/<id>/events). */
  readonly publishArchived: (sessionId: string, archived: boolean) => Promise<void>;
  readonly now: () => number;
}

/**
 * Current-project sessions, newest first: active by default, or archived only with `archived: true`.
 * The project match is the workspace basename (the inventory's `project`); a null project lists all.
 */
export function selectSessions(
  summaries: readonly SessionSummary[],
  project: string | null,
  opts: { readonly archived: boolean },
): SessionSummary[] {
  const scope = opts.archived ? archivedSessions(summaries) : activeSessions(summaries);
  const inProject = project != null ? scope.filter((s) => s.project === project) : scope;
  return [...inProject].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A compact one-line-per-session listing (id, branch, title, activity/presence, relative time). */
export function renderSessions(summaries: readonly SessionSummary[], nowMs: number): string {
  if (summaries.length === 0) {
    return "No sessions.";
  }
  return summaries
    .map((s) => {
      const branch = s.branch ? ` (${s.branch})` : "";
      const flags = [s.activity === "running" ? "running" : null, s.host]
        .filter(Boolean)
        .join(", ");
      return `${s.sessionId}${branch}  ${s.title}  [${flags}] ${relativeTime(s.updatedAt, nowMs)}`;
    })
    .join("\n");
}

/** Runs `trevor list [--archived]` for the given project, returning the rendered listing. */
export async function runList(
  io: LifecycleIo,
  project: string | null,
  archived: boolean,
): Promise<string> {
  const all = await io.fetchSessions();
  const scoped = selectSessions(all, project, { archived });
  const header = archived ? "Archived sessions" : "Sessions";
  return `${header}${project ? ` for ${project}` : ""}:\n${renderSessions(scoped, io.now())}`;
}

/** Runs `trevor archive|unarchive <session>`, publishing the durable marker. */
export async function runArchive(
  io: LifecycleIo,
  sessionId: string,
  archived: boolean,
): Promise<string> {
  if (!sessionId) {
    return `usage: trevor ${archived ? "archive" : "unarchive"} <session>`;
  }
  await io.publishArchived(sessionId, archived);
  return `${archived ? "Archived" : "Unarchived"} ${sessionId}.`;
}

/** The host-control IO for stop/kill (the launcher's ownership records + process signalling). */
export interface HostControlIo {
  /** The launcher-owned host record for a session, or null when none is recorded. */
  readonly lookupHost: (sessionId: string) => { readonly pid: number } | null;
  readonly processAlive: (pid: number) => boolean;
  readonly signal: (pid: number, sig: "SIGTERM" | "SIGKILL") => void;
  /** Drops the ownership record for a session (after a stop/kill). */
  readonly removeHost: (sessionId: string) => void;
}

/**
 * Runs `trevor stop|kill <session>` (D-094 M1/M3). Stop sends SIGTERM - the host's signal handler
 * shuts down gracefully (kills its background jobs and exits; a later leader reaps any in-flight
 * run). Kill sends SIGKILL for a wedged host. Either way the durable log is untouched. A
 * stale/missing record is reported and cleaned up rather than signalling an unrelated pid.
 */
export function runStop(io: HostControlIo, sessionId: string, kill: boolean): string {
  if (!sessionId) {
    return `usage: trevor ${kill ? "kill" : "stop"} <session>`;
  }
  const record = io.lookupHost(sessionId);
  if (!record) {
    return `No running host recorded for ${sessionId}.`;
  }
  if (!io.processAlive(record.pid)) {
    io.removeHost(sessionId);
    return `Host for ${sessionId} was already gone (cleaned up the stale record).`;
  }
  io.signal(record.pid, kill ? "SIGKILL" : "SIGTERM");
  io.removeHost(sessionId);
  return kill
    ? `Killed the host for ${sessionId} (pid ${record.pid}).`
    : `Stopping the host for ${sessionId} (pid ${record.pid})…`;
}
