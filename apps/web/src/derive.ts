import {
  type CommandSpec,
  decodeTrevorEvent,
  type ProviderModel,
  type SessionEvent,
  type TaskSnapshot,
} from "@trevor/richter";

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
 * Derives host presence from the lease's host.* events. The current leader is the
 * host whose latest role is "leader" - shown as last-known, since a lone leader
 * goes silent. A standby pings every heartbeat, so live standbys are those seen
 * within HOST_RECENT_MS (excluding the leader); stale ids from dead hosts drop off.
 */
export function hostStatus(events: readonly SessionEvent[], nowMs: number): HostStatus {
  let present = false;
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
      present = true;
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
  let leaderId: string | null = null;
  let leaderSeen = Number.NEGATIVE_INFINITY;
  for (const [id, value] of role) {
    const seen = lastSeen.get(id) ?? Number.NEGATIVE_INFINITY;
    if (value === "leader" && seen >= leaderSeen) {
      leaderSeen = seen;
      leaderId = id;
    }
  }
  let standbyCount = 0;
  for (const [id, at] of lastSeen) {
    if (id !== leaderId && nowMs - at < HOST_RECENT_MS) {
      standbyCount += 1;
    }
  }
  return { present, leaderId, standbyCount, workspace, cwd };
}

// Used until the host announces itself: qwen is binary, GPT graduated.
export const QWEN_FALLBACK: ProviderModel = {
  label: "Qwen (local)",
  model: "qwen",
  reasoningLevels: ["off", "on"],
  defaultReasoning: "off",
};
export const FALLBACK_MODELS: Record<string, ProviderModel> = {
  qwen: QWEN_FALLBACK,
  gpt: {
    label: "GPT-5.5",
    model: "GPT-5.5",
    reasoningLevels: ["minimal", "low", "medium", "high", "xhigh"],
    defaultReasoning: "medium",
  },
};

/** The latest per-provider model/reasoning map the host announced, else the fallback. */
export function providerModelsFrom(events: readonly SessionEvent[]): Record<string, ProviderModel> {
  let latest: Record<string, ProviderModel> | null = null;
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "host.online") {
      latest = decoded.models;
    }
  }
  return latest ?? FALLBACK_MODELS;
}

/** The latest task checklist the host published (empty when there are no tasks / cleared). */
export function tasksFrom(events: readonly SessionEvent[]): TaskSnapshot[] {
  let latest: TaskSnapshot[] = [];
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "tasks.current") {
      latest = [...decoded.tasks];
    }
  }
  return latest;
}

/** The immediate-command inventory the host last announced (empty until one is online). */
export function commandsFrom(events: readonly SessionEvent[]): CommandSpec[] {
  let latest: CommandSpec[] = [];
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "host.online") {
      latest = [...decoded.commands];
    }
  }
  return latest;
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
