import {
  type CatalogEntry,
  type CommandSpec,
  type DecodedEvent,
  decodeTrevorEvent,
  type GitStatus,
  HOST_ROLE,
  type HostPresence,
  type ProviderModel,
  type SessionEvent,
  type SourceSignInState,
  type SourceSummary,
  type TaskSnapshot,
  type WorktreeSummary,
} from "@trevor/session";

/** The last value `pick` yields over the decoded log (the newest snapshot), else undefined. */
function latest<T>(
  events: readonly SessionEvent[],
  pick: (decoded: DecodedEvent, event: SessionEvent) => T | undefined,
): T | undefined {
  let result: T | undefined;

  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    const value = decoded ? pick(decoded, event) : undefined;
    if (value !== undefined) {
      result = value;
    }
  }

  return result;
}

/**
 * Pure view-model derivations over the Richter event log, kept out of App.tsx so
 * the component is just rendering. Each folds `readonly SessionEvent[]` into a
 * typed shape via `decodeTrevorEvent`, so none of them hand-guard raw payloads.
 */

/**
 * The run currently in flight, or null. The host runs ONE turn at a time, so only the MOST
 * RECENT run can still be active: it's in flight iff the last `assistant.started` has no matching
 * `assistant.completed`. An older started-without-completion (a turn whose host crashed or was
 * interrupted before it could emit a completion) is a dead ORPHAN - it must not count, or `busy`
 * would latch forever and the local send queue would never drain (queued prompts stuck dimmed).
 * A `/clear` resets the detection too, mirroring the transcript: no pre-clear run is active after it.
 * Drives whether ESC cancels and which runId to target.
 */
export function activeRunId(events: readonly SessionEvent[]): string | null {
  const completed = new Set<string>();
  let lastStarted: string | null = null;

  for (const event of events) {
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

  return lastStarted && !completed.has(lastStarted) ? lastStarted : null;
}

/** Compact token count: 6100 -> "6.1k", 812 -> "812". */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Compact context window: 8192 -> "8k", 1000000 -> "1M", 0/unknown -> "?". */
export function fmtCtx(n: number): string {
  if (n <= 0) {
    return "?";
  }

  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
  }

  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Whether a host error string looks like a context-overflow / token-limit failure. */
export function isOverflowError(error: string): boolean {
  return /context|token limit|too long|too many tokens|maximum.*(context|tokens)|reduce the (length|size)/i.test(
    error,
  );
}

/** A concise, tool-aware label for a tool call (path/command/pattern, not the blob). */
export function toolSummary(name: string, argsJson: string): string {
  let args: Record<string, unknown> = {};

  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    return "";
  }

  const primary =
    name === "bash" ? args.command : name === "grep" || name === "glob" ? args.pattern : args.path;

  // With no recognized primary arg, fall back to the raw args JSON - but a no-arg tool (e.g. doctor)
  // has an empty object, and rendering "{}" as the summary is noise, so collapse it to nothing.
  const text =
    typeof primary === "string" ? primary : Object.keys(args).length === 0 ? "" : argsJson;

  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export type HostStatus = {
  branch: string | null;
  /** Structured git status from the latest host.online, or null on a non-git cwd. */
  git: GitStatus | null;
  cwd: string | null;
  leaderId: string | null;
  present: boolean;
  standbyCount: number;
  workspace: string | null;
};

/** A standby pings continuously, so it counts as present only if seen this recently. */
const HOST_RECENT_MS = 15000;

/**
 * Derives host presence. Liveness comes from the backend's LIVE connection set
 * (`presence`) when it reports one - a host is present only while its socket is open, so
 * a crashed/killed host disappears even though its host.online stays latched in the log.
 * The leader/cwd/workspace still come from the host.* events, but the leader counts only
 * if it is among the live sockets; the other live hosts are standbys.
 *
 * `presence === null` means the backend never reports presence (e.g. Richter): fall back
 * to the event-log view, where `present` latches on the first host.online (a lone leader
 * goes silent, so it can't be timed out) and standbys count only if seen within
 * HOST_RECENT_MS. This path cannot detect a silently-dead leader - the reason the live
 * set is preferred wherever a backend offers it.
 */
export function hostStatus(
  events: readonly SessionEvent[],
  presence: readonly HostPresence[] | null,
  nowMs: number,
): HostStatus {
  let everOnline = false;
  let branch: string | null = null;
  let git: GitStatus | null = null;
  let workspace: string | null = null;
  let cwd: string | null = null;

  const role = new Map<string, string>();
  const lastSeen = new Map<string, number>();

  for (const event of events) {
    const decoded = decodeTrevorEvent(event);

    if (!decoded) {
      continue;
    }

    if (decoded.type === "host.online") {
      everOnline = true;

      if (decoded.branch) {
        branch = decoded.branch;
      }

      // Structured git supersedes the legacy branch string; a host that omits it (older
      // host, or a non-git cwd) leaves the prior value, so the line degrades, not flips.
      if (decoded.git) {
        git = decoded.git;
      }

      if (decoded.workspace) {
        workspace = decoded.workspace;
      }

      if (decoded.cwd) {
        cwd = decoded.cwd;
      }
    }
    if (
      decoded.type === "host.online" ||
      decoded.type === "host.hello" ||
      decoded.type === "host.beat" ||
      decoded.type === "host.role"
    ) {
      const id = decoded.instanceId;

      if (!id) {
        continue;
      }

      const at = Date.parse(event.createdAt);

      lastSeen.set(id, Number.isNaN(at) ? nowMs : at);

      if (decoded.type === "host.role" && decoded.role) {
        role.set(id, decoded.role);
      }
    }
  }

  // The most recently elected leader, by event order (the id whose latest role is
  // "leader" and seen latest). Shared by both presence paths.
  let leaderId: string | null = null;
  let leaderSeen = Number.NEGATIVE_INFINITY;

  for (const [id, value] of role) {
    const seen = lastSeen.get(id) ?? Number.NEGATIVE_INFINITY;
    if (value === HOST_ROLE.leader && seen >= leaderSeen) {
      leaderSeen = seen;
      leaderId = id;
    }
  }

  // Live-connection path: the leader counts only if its socket is live; standbys are the
  // other live hosts. A host that connected but hasn't yet emitted its leader role shows
  // present with no leader ("host starting…"), which is exactly the transient truth.
  if (presence !== null) {
    const liveIds = new Set(presence.map((host) => host.instanceId));
    const leaderLive = leaderId !== null && liveIds.has(leaderId) ? leaderId : null;
    let standbyCount = 0;
    for (const id of liveIds) {
      if (id !== leaderLive) {
        standbyCount += 1;
      }
    }
    return {
      branch,
      git,
      cwd,
      leaderId: leaderLive,
      present: liveIds.size > 0,
      standbyCount,
      workspace,
    };
  }

  // Event-log fallback (no live presence reported).
  let standbyCount = 0;

  for (const [id, at] of lastSeen) {
    if (id !== leaderId && nowMs - at < HOST_RECENT_MS) {
      standbyCount += 1;
    }
  }

  return { branch, git, cwd, leaderId, present: everOnline, standbyCount, workspace };
}

/**
 * The latest per-provider model/reasoning map the host announced, or `{}` before any host
 * has joined this session. The host is the single source of the roster (labels curated in
 * buildProviders, reasoning options auto-detected), durably replayed from the session log -
 * so a previously-seen host's roster survives a restart, and a never-seen one yields an
 * empty picker rather than a hand-authored guess that could drift from what the host runs.
 */
export function providerModelsFrom(events: readonly SessionEvent[]): Record<string, ProviderModel> {
  return latest(events, (d) => (d.type === "host.online" ? d.models : undefined)) ?? {};
}

/** The host-announced model SOURCES (D-065), or [] before the host's catalog load completes. */
export function sourcesFrom(events: readonly SessionEvent[]): readonly SourceSummary[] {
  return latest(events, (d) => (d.type === "host.online" ? d.sources : undefined)) ?? [];
}

/** The host-announced per-source model catalog (D-065), keyed by sourceId, or {} before load. */
export function catalogFrom(
  events: readonly SessionEvent[],
): Readonly<Record<string, readonly CatalogEntry[]>> {
  return latest(events, (d) => (d.type === "host.online" ? d.catalog : undefined)) ?? {};
}

/**
 * The latest host-driven source sign-in state (D-065 M5), or null when none is in flight. A
 * `device-code` phase is shown in the chooser (URL + code); `complete`/`error`/`cancelled` are
 * terminal, so the chooser clears the prompt (a complete also re-announces the source as ready).
 */
export function sourceSignInFrom(events: readonly SessionEvent[]): SourceSignInState | null {
  return latest(events, (d) => (d.type === "host.sourceAuth" ? d.auth : undefined)) ?? null;
}

/**
 * The provider key the host announced as its default, or undefined before any host has
 * announced. The host owns the default (DEFAULT_PROVIDER) and ships it on host.online;
 * the UI's initial selection derives from this instead of hardcoding a provider key.
 */
export function defaultProviderFrom(events: readonly SessionEvent[]): string | undefined {
  return latest(events, (d) => (d.type === "host.online" && d.default ? d.default : undefined));
}

/** The latest task checklist the host published (empty when there are no tasks / cleared). */
export function tasksFrom(events: readonly SessionEvent[]): TaskSnapshot[] {
  return [...(latest(events, (d) => (d.type === "tasks.current" ? d.tasks : undefined)) ?? [])];
}

/** The immediate-command inventory the host last announced (empty until one is online). */
export function commandsFrom(events: readonly SessionEvent[]): CommandSpec[] {
  return [...(latest(events, (d) => (d.type === "host.online" ? d.commands : undefined)) ?? [])];
}

/** The managed worktrees the host last announced (empty until one is online), D-091. */
export function worktreesFrom(events: readonly SessionEvent[]): WorktreeSummary[] {
  return [...(latest(events, (d) => (d.type === "host.online" ? d.worktrees : undefined)) ?? [])];
}

interface LatestSessionSwitchOptions {
  readonly afterSeq?: number;
}

/** The newest host-authored session handoff target, optionally scoped after a replay boundary. */
export function latestSessionSwitch(
  events: readonly SessionEvent[],
  options: LatestSessionSwitchOptions = {},
): string | null {
  const afterSeq = options.afterSeq ?? Number.NEGATIVE_INFINITY;
  return (
    latest(events, (d, event) =>
      d.type === "session.switch" && d.sessionId && event.seq > afterSeq ? d.sessionId : undefined,
    ) ?? null
  );
}

/**
 * Whether this session is currently archived (D-094): the latest `session.archived` event wins, so an
 * unarchive (`archived: false`) clears it. Archived sessions are filtered out of the sidebar/resume
 * lists, but a deep link (`?session=`) or a session archived while it is open can still land the
 * browser here - the main UI then gates normal use behind an explicit unarchive.
 */
export function isSessionArchived(events: readonly SessionEvent[]): boolean {
  return latest(events, (d) => (d.type === "session.archived" ? d.archived : undefined)) ?? false;
}

/**
 * Parses composer text into a prompt-shell-lane command (D-082), or null for anything else. The
 * trigger is the RAW first character being `!` (not a trimmed/leading-whitespace match - typing a
 * space before `!` is an ordinary prompt), with a non-empty command after it. The returned `command`
 * is trimmed of surrounding whitespace. A lone `!` (no command) yields null, so the inert "empty
 * bang" composer state never publishes anything.
 */
export function parseBangShell(text: string): { command: string } | null {
  if (text[0] !== "!") {
    return null;
  }
  const command = text.slice(1).trim();
  return command ? { command } : null;
}

/**
 * Parses composer text into an immediate command, or null for an ordinary prompt.
 * A leading slash whose first token is a known command name routes to the command
 * lane; anything else (including an unknown /slash) is a normal model prompt.
 */
export function parseCommand(
  text: string,
  known: ReadonlySet<string>,
): { command: string; args: string } | null {
  if (!text.startsWith("/")) {
    return null;
  }

  const space = text.indexOf(" ");
  const command = space === -1 ? text : text.slice(0, space);

  if (!known.has(command)) {
    return null;
  }

  return { command, args: space === -1 ? "" : text.slice(space + 1).trim() };
}

/**
 * The start time (ms epoch) of the turn currently in flight, for the live "Working (elapsed)"
 * indicator: the active run's `assistant.started`, or - before the run starts - the trailing
 * `user.message` that kicked off the turn. Null when neither is found. The caller renders the
 * indicator only while busy, so a stale trailing user.message from an idle conversation is unused.
 */
export function activeTurnStartedAt(events: readonly SessionEvent[]): number | null {
  const runId = activeRunId(events);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    if (
      (runId && decoded.type === "assistant.started" && decoded.runId === runId) ||
      (!runId && decoded.type === "user.message")
    ) {
      const ms = Date.parse(event.createdAt);
      return Number.isNaN(ms) ? null : ms;
    }
  }
  return null;
}
