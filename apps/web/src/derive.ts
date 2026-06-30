import {
  type ArtifactRef,
  activeTurnRunId,
  type CatalogEntry,
  type CommandSpec,
  type DecodedEvent,
  decodeTrevorEvent,
  type GitStatus,
  HOST_ROLE,
  type HostPresence,
  type ProviderModel,
  type ProviderQuestionAnswer,
  type ProviderQuestionContract,
  type SessionEvent,
  type SourceSignInState,
  type SourceSummary,
  type TaskSnapshot,
  taskSnapshotReplaces,
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

/**
 * Human elapsed time from milliseconds. The single "how long did this take" formatter, parameterized
 * for the two surfaces that previously diverged: `hours` rolls over to `1h 5m` past an hour (the
 * message timing line); `tenths` shows `<1s` and one decimal under 10s (the tool-call duration chip).
 * Both share the `Mm Ss` / `Ss` breakpoints in between.
 */
export function formatElapsed(
  ms: number,
  opts: { readonly tenths?: boolean; readonly hours?: boolean } = {},
): string {
  if (opts.tenths && ms < 1000) {
    return "<1s";
  }
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (opts.hours && totalSeconds >= 3600) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  if (opts.tenths && totalSeconds < 10) {
    return `${(Math.floor((ms / 1000) * 10) / 10).toFixed(1)}s`;
  }
  return `${seconds}s`;
}

/**
 * Splits a message's artifacts into inline `images` and `others` (file rows). The one owner of the
 * image-vs-other rule, so the attachments wrapper and the image set can't classify an artifact two
 * different ways.
 */
export function partitionArtifacts(artifacts: readonly ArtifactRef[]): {
  readonly images: readonly ArtifactRef[];
  readonly others: readonly ArtifactRef[];
} {
  const images: ArtifactRef[] = [];
  const others: ArtifactRef[] = [];
  for (const artifact of artifacts) {
    (artifact.kind === "image" ? images : others).push(artifact);
  }
  return { images, others };
}

/** Truncates `text` to `max` characters with an ellipsis. The one owner of the transcript's
 *  60-char cap idiom (the session-name preview and the tool summary share it). */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The project label from a workspace/cwd path: its last path segment, ignoring `~` (the home marker
 * isn't a project name). Null when there's nothing meaningful. The one owner of the "workspace
 * basename ignoring ~" rule the tab title and the resume/sidebar scoping both derive, so they can't
 * disagree on what the current project is called.
 */
export function workspaceBasename(path: string | null | undefined): string | null {
  const base = path?.split("/").filter(Boolean).pop();
  return base && base !== "~" ? base : null;
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

  return truncate(text, 60);
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

/**
 * The FRESHEST task checklist the host published (empty when there are no tasks / cleared). Selects by
 * the snapshot's monotonic revision rather than blindly taking the last array entry, so a stale
 * `tasks.current` - one with an older revision that arrives or is replayed after a newer one - cannot
 * overwrite the current checklist. Ties (equal revision, including the legacy 0 every pre-09 event
 * shares) go to the later arrival, preserving latest-wins for old logs. The comparison is shared with
 * the host load guard via `taskSnapshotReplaces`, so the two never disagree. <!-- D-004 -->
 */
export function tasksFrom(events: readonly SessionEvent[]): TaskSnapshot[] {
  let bestRev = Number.NEGATIVE_INFINITY;
  let bestTasks: readonly TaskSnapshot[] | undefined;

  for (const event of events) {
    const decoded = decodeTrevorEvent(event);

    if (decoded?.type === "tasks.current" && taskSnapshotReplaces(decoded.rev, bestRev)) {
      bestRev = decoded.rev;
      bestTasks = decoded.tasks;
    }
  }

  return bestTasks ? [...bestTasks] : [];
}

/**
 * Whether the live checklist is STALE: the model last touched it BEFORE the user's most recent
 * message, so the panel is showing a plan the conversation has already moved past (the "stale tasks"
 * complaint - e.g. an audit checklist still visible after the owner switched to a new request). A
 * soft, non-destructive signal that only drives the panel's "stale" badge + dismiss nudge; the model
 * staying silent on the checklist is exactly the abandonment this surfaces. An empty or absent
 * checklist is never stale (the panel hides itself). Pure over the log. <!-- 09.1 -->
 */
export function tasksStale(events: readonly SessionEvent[]): boolean {
  let lastTasksAt = -1;
  let lastTasksEmpty = true;
  let lastUserMessageAt = -1;

  events.forEach((event, index) => {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type === "tasks.current") {
      lastTasksAt = index;
      lastTasksEmpty = decoded.tasks.length === 0;
    } else if (decoded?.type === "user.message") {
      lastUserMessageAt = index;
    }
  });

  return lastTasksAt >= 0 && !lastTasksEmpty && lastUserMessageAt > lastTasksAt;
}

/** A pending ask_user question projected from the log: the contract to render + its lifecycle ids. */
export interface PendingQuestion {
  readonly questionId: string;
  readonly runId: string;
  readonly contract: ProviderQuestionContract;
}

/**
 * The newest UNRESOLVED ask_user question, or null. A `provider.question.requested` is pending until a
 * `provider.question.resolved` for the same `questionId` arrives (the host emits that on answer, decline,
 * or run-end). Drives the live QuestionSurface (M5); ask_user is a serial barrier so at most one is open.
 */
export function pendingQuestionFrom(events: readonly SessionEvent[]): PendingQuestion | null {
  const requested = new Map<string, PendingQuestion>();
  const resolved = new Set<string>();
  for (const event of events) {
    const d = decodeTrevorEvent(event);
    if (d?.type === "provider.question.requested") {
      requested.set(d.questionId, {
        questionId: d.questionId,
        runId: d.runId,
        contract: d.contract,
      });
    } else if (d?.type === "provider.question.resolved") {
      resolved.add(d.questionId);
    }
  }
  let pending: PendingQuestion | null = null;
  for (const [id, question] of requested) {
    if (!resolved.has(id)) {
      pending = question;
    }
  }
  return pending;
}

/**
 * A generated (`/handoff`) handoff awaiting the user's approve/edit/reject. `generating` while the model
 * drafts the target prompt; `generated` once the draft exists. Drives the approval surface that replaces
 * the composer - the lifecycle the dead-end `/handoff` failure used to skip (02.10).
 */
export type PendingHandoff =
  | { readonly status: "generating"; readonly handoffId: string }
  | { readonly status: "generated"; readonly handoffId: string; readonly prompt: string };

/**
 * The newest generate-mode handoff still awaiting a decision, or null. A handoff is tracked from
 * `handoff.generating`/`generated` and cleared by any terminal event (`approved`/`rejected`/`failed`/
 * `accepted`) for the same `handoffId`. Direct-mode handoffs (no generating/generated) never surface
 * here, so `/handoff --direct` keeps switching immediately with no approval step.
 */
export function pendingHandoffFrom(events: readonly SessionEvent[]): PendingHandoff | null {
  const byId = new Map<string, PendingHandoff>();
  for (const event of events) {
    const d = decodeTrevorEvent(event);
    if (!d) {
      continue;
    }
    if (d.type === "handoff.generating") {
      byId.set(d.handoffId, { status: "generating", handoffId: d.handoffId });
    } else if (d.type === "handoff.generated") {
      byId.set(d.handoffId, { status: "generated", handoffId: d.handoffId, prompt: d.prompt });
    } else if (
      d.type === "handoff.approved" ||
      d.type === "handoff.rejected" ||
      d.type === "handoff.failed" ||
      d.type === "handoff.accepted"
    ) {
      byId.delete(d.handoffId);
    }
  }
  let pending: PendingHandoff | null = null;
  for (const handoff of byId.values()) {
    pending = handoff;
  }
  return pending;
}

/** How a provider question terminated (the `provider.question.resolved` outcome). */
export type QuestionOutcome = "answered" | "declined" | "cancelled" | "expired";

/** The slim, render-ready view of a resolved ask_user interaction (D-002/D-004). */
export interface ResolvedQuestionView {
  readonly outcome: QuestionOutcome;
  /** One row per asked question: its id (a stable React key), prompt, and the user's answer
   *  (answer "" when not answered). */
  readonly items: readonly {
    readonly id: string;
    readonly question: string;
    readonly answer: string;
  }[];
  /** A one-line summary for compact rendering: the accept's combined summary, else the host's
   *  resolved summary, else a plain outcome label. */
  readonly summary: string;
}

const OUTCOME_LABEL: Record<QuestionOutcome, string> = {
  answered: "Answered",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
};

/** Narrow the permissively-decoded resolved outcome to a known one; an unrecognized (forward-compat
 *  or corrupt) value reads as "cancelled" so it is never mistaken for a successful answer. */
function coerceOutcome(outcome: string): QuestionOutcome {
  return outcome === "answered" ||
    outcome === "declined" ||
    outcome === "cancelled" ||
    outcome === "expired"
    ? outcome
    : "cancelled";
}

/**
 * Pairs a resolved ask_user question's three durable events into a render view-model (D-004): the
 * requested `contract` supplies the question text, the `answer` supplies what the user picked (paired
 * by question id), and the resolved `outcome`/`summary` supply the terminal state. Tolerates a missing
 * contract or answer (older/compacted logs) by falling back to the resolved summary - it never throws
 * and never drops the item. Pure and React-free so it unit-tests on its own.
 */
export function summarizeProviderQuestion(input: {
  readonly contract?: ProviderQuestionContract;
  readonly answer?: ProviderQuestionAnswer;
  readonly outcome: string;
  readonly summary: string;
}): ResolvedQuestionView {
  const { contract, answer, summary } = input;
  const outcome = coerceOutcome(input.outcome);
  const answerById =
    answer?.action === "accept"
      ? new Map(answer.questions.map((a) => [a.id, a.answer] as const))
      : new Map<string, string>();
  const items = (contract?.questions ?? []).map((q) => ({
    id: q.id,
    question: q.question,
    answer: answerById.get(q.id) ?? "",
  }));
  const accepted = answer?.action === "accept" ? answer.answer.trim() : "";
  const headline = accepted || summary.trim() || OUTCOME_LABEL[outcome];
  return { outcome, items, summary: headline };
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
  const runId = activeTurnRunId(events);
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

/** The epoch-ms timestamp of the most recent event with a parseable `createdAt`, or null. */
function lastEventAt(events: readonly SessionEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ms = Date.parse(events[i]?.createdAt ?? "");
    if (!Number.isNaN(ms)) {
      return ms;
    }
  }
  return null;
}

/** An orphaned in-flight turn the browser can recover, with how long it has been silent. */
export interface OrphanedTurn {
  readonly runId: string;
  readonly silentMs: number;
}

/** Inputs for {@link detectOrphanedTurn}, all sampled in App from the live stream + host presence. */
export interface OrphanCheck {
  /** A leader host is currently connected (could still produce the terminal event). */
  readonly leaderPresent: boolean;
  /** The browser has a live, fully-replayed view of the log (not mid-connect / mid-replay). */
  readonly connected: boolean;
  /** Current wall clock (ms epoch); ticks periodically so the check re-evaluates. */
  readonly now: number;
  /** How long the log must be silent before the browser steps in (ms). */
  readonly graceMs: number;
}

/**
 * Detects an in-flight turn that is ORPHANED - one with no terminal event, while no leader host is
 * connected to ever write one. This is the client-side mirror of the host's reap-on-reconnect
 * (turn-machine `reapExcept`): when a host restarts/crashes mid-turn, or the host<->store socket
 * flapped exactly at turn-end, and nothing rejoins to win the lease, no host will EVER emit the
 * `assistant.completed` - so the "Working" spinner latches forever. The browser may then close the
 * turn itself, but only when it is certain no host can: an in-flight run, no leader present, a live
 * replayed view of the log, and no new event for `graceMs` (so a host that is merely mid-reconnect
 * gets first crack at its own reconcile before the browser does). Returns the orphaned run, or null.
 *
 * Deliberately conservative: it never fires while a leader is connected (a live but slow/stalled turn
 * is the host's to finish), nor while the browser is disconnected or replaying (it would be acting on
 * a partial or stale view). Pure over the inputs, so the firing policy is unit-testable without a DOM.
 */
export function detectOrphanedTurn(
  events: readonly SessionEvent[],
  check: OrphanCheck,
): OrphanedTurn | null {
  const runId = activeTurnRunId(events);
  if (!runId || check.leaderPresent || !check.connected) {
    return null;
  }
  const lastAt = lastEventAt(events);
  if (lastAt === null) {
    return null;
  }
  const silentMs = check.now - lastAt;
  return silentMs >= check.graceMs ? { runId, silentMs } : null;
}

/** True when the newest turn-boundary event is a `user.message` - i.e. a prompt is awaiting a reply with
 *  no later `assistant.started`/`assistant.completed` answering it. */
function newestTurnIsUnansweredPrompt(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }
    if (decoded.type === "user.message") {
      return true;
    }
    if (decoded.type === "assistant.started" || decoded.type === "assistant.completed") {
      return false;
    }
  }
  return false;
}

/**
 * Whether a trailing prompt is STRANDED with no host to run it - the disjoint twin of
 * {@link detectOrphanedTurn}. That recovers a run which STARTED but never completed (a host that
 * crashed/flapped mid-turn); this fires when NOTHING ever started: the newest turn is an unanswered
 * `user.message`, no run is in flight (`activeTurnRunId === null`), no leader is connected, the view is
 * live + replayed, and the log has been silent past the grace.
 *
 * A `user.message` published while no host is attached gets no `assistant.started` (nothing is there to
 * start it), so the busy derivation otherwise spins "Working" forever even though no turn exists. This
 * is NOT data loss - the host's reattach catch-up (`pendingCatchUp`) answers the queued prompt the
 * moment a host returns - so the browser presents the existing no-host affordance instead of a fake
 * spinner. Pure over its inputs and never publishes (there is no runId to reconcile, unlike the orphan
 * guard). <!-- D-001 D-002 -->
 */
export function isHostlessPendingPrompt(
  events: readonly SessionEvent[],
  check: OrphanCheck,
): boolean {
  if (activeTurnRunId(events) !== null || check.leaderPresent || !check.connected) {
    return false;
  }
  if (!newestTurnIsUnansweredPrompt(events)) {
    return false;
  }
  const lastAt = lastEventAt(events);
  if (lastAt === null) {
    return false;
  }
  return check.now - lastAt >= check.graceMs;
}
