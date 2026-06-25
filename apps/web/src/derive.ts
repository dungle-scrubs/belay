import {
  type CommandSpec,
  type DecodedEvent,
  decodeTrevorEvent,
  HOST_ROLE,
  type HostPresence,
  type ProviderModel,
  type SessionEvent,
  type TaskSnapshot,
} from "@trevor/session";

/** The last value `pick` yields over the decoded log (the newest snapshot), else undefined. */
function latest<T>(
  events: readonly SessionEvent[],
  pick: (decoded: DecodedEvent) => T | undefined,
): T | undefined {
  let result: T | undefined;

  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    const value = decoded ? pick(decoded) : undefined;
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
 * The run currently in flight: the latest assistant.started whose run has not
 * yet completed, or null. Drives whether ESC cancels and which runId to target.
 */
export function activeRunId(events: readonly SessionEvent[]): string | null {
  const completed = new Set<string>();
  const started: string[] = [];

  for (const event of events) {
    const decoded = decodeTrevorEvent(event);

    if (decoded?.type === "assistant.started") {
      started.push(decoded.runId);
    } else if (decoded?.type === "assistant.completed") {
      completed.add(decoded.runId);
    }
  }

  for (let i = started.length - 1; i >= 0; i -= 1) {
    const id = started[i];

    if (id && !completed.has(id)) {
      return id;
    }
  }

  return null;
}

/** Compact token count: 6100 -> "6.1k", 812 -> "812". */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Compact context window: 8192 -> "8k", 0/unknown -> "?". */
export function fmtCtx(n: number): string {
  if (n <= 0) {
    return "?";
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

  const text = typeof primary === "string" ? primary : argsJson;

  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export type HostStatus = {
  present: boolean;
  leaderId: string | null;
  standbyCount: number;
  workspace: string | null;
  cwd: string | null;
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
    return { present: liveIds.size > 0, leaderId: leaderLive, standbyCount, workspace, cwd };
  }

  // Event-log fallback (no live presence reported).
  let standbyCount = 0;

  for (const [id, at] of lastSeen) {
    if (id !== leaderId && nowMs - at < HOST_RECENT_MS) {
      standbyCount += 1;
    }
  }

  return { present: everOnline, leaderId, standbyCount, workspace, cwd };
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
