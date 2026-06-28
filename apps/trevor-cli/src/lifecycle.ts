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

/** Where `trevor open <session>` should launch: the session id + its absolute workspace root. */
export interface OpenTarget {
  readonly sessionId: string;
  readonly root: string;
}

/** Expands a leading `~` in an abbreviated path against `home` (e.g. `~/dev/x` → `<home>/dev/x`). */
export function expandHome(dir: string, home: string): string {
  if (dir === "~") {
    return home;
  }
  return dir.startsWith("~/") ? home + dir.slice(1) : dir;
}

/**
 * Resolves `trevor open <session>` (D-094 M3) against the store inventory: the requested session's
 * absolute workspace root (so the launcher can spawn-or-attach a host pointed at it), or a clear
 * message when the id is missing, unknown, or has no recorded workspace. Pure over the injected
 * inventory + home, so it is unit-tested without the store; `main.ts` then drives the real launch.
 */
export function resolveOpenTarget(
  summaries: readonly SessionSummary[],
  sessionId: string,
  home: string,
): OpenTarget | { readonly error: string } {
  if (!sessionId) {
    return { error: "usage: trevor open <session>" };
  }
  const summary = summaries.find((s) => s.sessionId === sessionId);
  if (!summary) {
    return {
      error: `No session "${sessionId}" found. Run \`trevor list\` to see this project's sessions.`,
    };
  }
  // A soft-deleted session is hidden from every view (sidebar Delete); opening one directly by id
  // would resurrect it, so it is refused like archive but without an unarchive path here.
  if (summary.deleted) {
    return { error: `Session "${sessionId}" was deleted.` };
  }
  // Archived sessions require an explicit unarchive before opening (D-094 M2): opening one directly
  // would resurrect a filed session without the user clearing its archived flag first.
  if (summary.archived) {
    return {
      error: `Session "${sessionId}" is archived. Run \`trevor unarchive ${sessionId}\` first, then open it.`,
    };
  }
  const dir = summary.workspace ?? summary.cwd;
  if (!dir) {
    return {
      error: `Session "${sessionId}" has no recorded workspace, so it can't be opened directly.`,
    };
  }
  return { sessionId, root: expandHome(dir, home) };
}
