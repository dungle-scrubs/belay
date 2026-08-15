import { selectSessions } from "@belay/sdk";
import { relativeTime, type SessionSummary } from "@belay/session";

/**
 * The `belay` session-lifecycle subcommands (D-094 M3). The PURE selection/resolution logic
 * (`selectSessions`, `resolveOpenTarget`, `expandHome`) now lives in `@belay/sdk` as the single source
 * shared with every headless consumer (plan 28 M6/M7) and is re-exported here so this app's callers and
 * tests keep one import. What stays app-owned is what does not belong in a browser-safe package: the
 * terminal RENDERING (`renderSessions`), the `LifecycleIo`-shaped command flow (`runList`/`runArchive`),
 * and OS process SIGNALLING (`runStop`/`HostControlIo`). `main.ts` wires the real IO over an SDK client.
 */

// Single source of the pure lifecycle workflow: the SDK owns it; the CLI re-exports so it cannot drift.
export {
  expandHome,
  type OpenTarget,
  resolveOpenTarget,
  selectSessions,
} from "@belay/sdk";

export interface LifecycleIo {
  /** The durable store's inventory (GET /sessions). */
  readonly fetchSessions: () => Promise<readonly SessionSummary[]>;
  /** Publishes a session.archived marker (POST /sessions/<id>/events) through the SDK. */
  readonly publishArchived: (sessionId: string, archived: boolean) => Promise<void>;
  readonly now: () => number;
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

/** Runs `belay list [--archived]` for the given project, returning the rendered listing. */
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

/** Runs `belay archive|unarchive <session>`, publishing the durable marker through the SDK. */
export async function runArchive(
  io: LifecycleIo,
  sessionId: string,
  archived: boolean,
): Promise<string> {
  if (!sessionId) {
    return `usage: belay ${archived ? "archive" : "unarchive"} <session>`;
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
 * Runs `belay stop|kill <session>` (D-094 M1/M3). Stop sends SIGTERM - the host's signal handler
 * shuts down gracefully (kills its background jobs and exits; a later leader reaps any in-flight
 * run). Kill sends SIGKILL for a wedged host. Either way the durable log is untouched. A
 * stale/missing record is reported and cleaned up rather than signalling an unrelated pid. This is
 * deliberately CLI/local-owned (OS signalling), NOT an SDK workflow: the SDK's protocol-safe run
 * control is `cancel` (a `user.cancel` event), which is a different thing.
 */
export function runStop(io: HostControlIo, sessionId: string, kill: boolean): string {
  if (!sessionId) {
    return `usage: belay ${kill ? "kill" : "stop"} <session>`;
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
