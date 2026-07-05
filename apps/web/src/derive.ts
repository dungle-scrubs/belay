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
  isTerminalDelegationStatus,
  type ModelRef,
  type ProviderModel,
  type ProviderQuestionAnswer,
  type ProviderQuestionContract,
  type SessionEvent,
  type SessionSummary,
  type SourceSignInState,
  type SourceSummary,
  type SupervisorProject,
  type TaskSnapshot,
  taskSnapshotReplaces,
  type WorktreeSummary,
} from "@trevor/session";
import type { PanelJob } from "@/support-panel/support-panel";
import { type TurnActionEvidence, toolActionLabel, turnActionLabel } from "./action-label";

export { parseToolArgs, toolSummary } from "./tool-args";

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
 * Pure view-model derivations over the Richter event log, kept out of app.tsx so
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

/** Bytes rounded to a compact KB/MB label, omitted when absent or zero. */
export function fmtBytes(bytes: number | undefined): string | undefined {
  if (!bytes || bytes <= 0) {
    return undefined;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

/**
 * The known workspace root for a session, derived ONCE from every place it might be recorded, so the
 * 44.2 picker and the 44.3 session-view "start host" agree on where to launch (plan 44.3 M1.5). A dead
 * or stale host still latches its `workspace`/`cwd` in the viewed session's log, so that is preferred;
 * a never-loaded log falls back to the inventory summary, then to the supervisor's `projects.json`
 * mapping (`SupervisorProject.sessionId -> .root`). Null when no source knows the root - the session
 * view then keeps the plain no-host hint rather than offering a "start host" that has nowhere to launch.
 */
export function resolveKnownRoot(sources: {
  readonly host: Pick<HostStatus, "workspace" | "cwd">;
  readonly summary?: Pick<SessionSummary, "workspace" | "cwd"> | undefined;
  readonly project?: Pick<SupervisorProject, "root"> | undefined;
}): string | null {
  // First NON-EMPTY source wins: an empty-string workspace/cwd/root is treated as absent (not a launchable
  // root), so it never becomes a "start host" pointing at nowhere.
  const candidates = [
    sources.host.workspace,
    sources.host.cwd,
    sources.summary?.workspace,
    sources.summary?.cwd,
    sources.project?.root,
  ];
  return candidates.find((root) => root != null && root !== "") ?? null;
}

export type HostAnnouncement = Extract<DecodedEvent, { readonly type: "host.online" }>;

/** The latest host.online announcement. Owns the host-owned roster/config/worktree snapshot fold. */
export function hostAnnouncement(events: readonly SessionEvent[]): HostAnnouncement | null {
  return latest(events, (d) => (d.type === "host.online" ? d : undefined)) ?? null;
}

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
  announcement: HostAnnouncement | null = hostAnnouncement(events),
): HostStatus {
  let everOnline = false;
  let branch: string | null = announcement?.branch ?? null;
  let git: GitStatus | null = announcement?.git ?? null;
  let workspace: string | null = announcement?.workspace ?? null;
  let cwd: string | null = announcement?.cwd ?? null;

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
export function providerModelsFrom(
  announcement: HostAnnouncement | null,
): Record<string, ProviderModel> {
  return announcement?.models ?? {};
}

/** The host-announced model SOURCES (D-065), or [] before the host's catalog load completes. */
export function sourcesFrom(announcement: HostAnnouncement | null): readonly SourceSummary[] {
  return announcement?.sources ?? [];
}

/** The host-announced per-source model catalog (D-065), keyed by sourceId, or {} before load. */
export function catalogFrom(
  announcement: HostAnnouncement | null,
): Readonly<Record<string, readonly CatalogEntry[]>> {
  return announcement?.catalog ?? {};
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
export function defaultProviderFrom(announcement: HostAnnouncement | null): string | undefined {
  return announcement?.default;
}

/**
 * Whether the host announced Vim-mode prompt motions as enabled (plan 06). The host owns the preference
 * (its vim.json config) and ships it on host.online; the composer gates its opt-in Vim layer on this
 * instead of browser state. Defaults to false until a host announces (no host -> no Vim mode).
 */
export function vimEnabledFrom(announcement: HostAnnouncement | null): boolean {
  return announcement?.vimEnabled ?? false;
}

/** The host-owned model preference: the durable default + favorites (pinned). */
export interface ModelPrefsView {
  readonly default: ModelRef | null;
  readonly pinned: readonly ModelRef[];
}

/**
 * The host-announced model preference (plan 51): the durable default model + the favorites (pinned). The
 * host owns it (its `model-prefs.json`) and ships it on host.online; the chooser reads default/favorites
 * from here instead of a per-browser localStorage blob, and the initial-model pick starts a fresh session
 * on the default. Defaults to `{ default: null, pinned: [] }` until a host announces or when a host omits
 * it (older host), so there is simply no default/favorites rather than a crash.
 */
export function modelPrefsFrom(announcement: HostAnnouncement | null): ModelPrefsView {
  return announcement?.modelPrefs ?? { default: null, pinned: [] };
}

/**
 * The host's latest tracked background jobs (plan 09): the freshest `host.online` job snapshots (the host
 * re-announces on every job change), empty when none / no host.
 *
 * Orphan reconcile (plan 52 / D-003): a promoted job carries NO durable per-job event - it exists only on
 * the `host.online` snapshot - so it cannot mirror the subagent reconcile with a terminal event. Instead
 * this pure derivation downgrades a `running` job to `interrupted` when the snapshot's AUTHOR is no longer
 * the live leader (`announcement.instanceId !== leaderId`, the same host-liveness verdict `hostStatus`
 * already computes): a dead host's `running` jobs are really orphaned, so the panel renders them terminal
 * with the kill control inert rather than a stuck "running". When the announcing host IS the live leader,
 * or its identity is unknown, jobs pass through untouched. `leaderId` defaults to the announcer, so a
 * caller that omits the liveness verdict (tests / stories) sees no downgrade.
 */
export function jobsFrom(
  announcement: HostAnnouncement | null,
  leaderId: string | null = announcement?.instanceId ?? null,
): readonly PanelJob[] {
  const jobs = announcement?.jobs ?? [];
  const authorStale = announcement?.instanceId != null && announcement.instanceId !== leaderId;
  if (!authorStale) {
    return jobs;
  }
  return jobs.map((job) => (job.status === "running" ? { ...job, interrupted: true } : job));
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

/** The provider/model/effort the session last ran a user turn on. */
export interface LastUserModel {
  readonly provider: string;
  readonly model?: ModelRef;
  readonly reasoning?: string;
}

/**
 * The model + effort the session last ran a user turn on - the most recent `user.message` carrying a
 * provider. For a freshly handed-off session that's the model the handoff stamped onto its first
 * prompt (handoff-flow.ts), so the picker can INHERIT it instead of falling back to the host default
 * (which is how a handoff target silently landed on the wrong model). Null until a user turn exists.
 */
export function lastUserModelFrom(events: readonly SessionEvent[]): LastUserModel | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const decoded = event ? decodeTrevorEvent(event) : null;
    if (decoded?.type === "user.message" && decoded.provider) {
      return {
        provider: decoded.provider,
        ...(decoded.model ? { model: decoded.model } : {}),
        ...(decoded.reasoning ? { reasoning: decoded.reasoning } : {}),
      };
    }
  }
  return null;
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
export function commandsFrom(announcement: HostAnnouncement | null): CommandSpec[] {
  return [...(announcement?.commands ?? [])];
}

/** The managed worktrees the host last announced (empty until one is online), D-091. */
export function worktreesFrom(announcement: HostAnnouncement | null): WorktreeSummary[] {
  return [...(announcement?.worktrees ?? [])];
}

interface LatestSessionSwitchOptions {
  readonly afterSeq?: number;
}

/** The newest host-authored session handoff target, optionally scoped after a replay boundary. */
/** The current local-model admission wait for the active turn (plan 11 M7), for the "waiting for the
 *  local runtime" status row. */
export interface AdmissionWaiting {
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly priority: string;
  /** The 0-based queue position when known. */
  readonly position?: number;
}

/**
 * The active turn's local-model admission wait, or null when it is not waiting (plan 11 M7). Scoped to
 * the in-flight run: its LATEST `admission.status` of phase `queued` is a live wait; any later
 * acquired/released/cancelled/refused supersedes it (chronologically) and clears the wait. So a turn
 * queued behind another project/subagent shows a bounded "waiting for LM Studio" status, never durable
 * transcript content.
 */
export function admissionWaiting(events: readonly SessionEvent[]): AdmissionWaiting | null {
  const runId = activeTurnRunId(events);
  if (!runId) {
    return null;
  }
  const status = latest(events, (d) =>
    d.type === "admission.status" && d.runId === runId ? d : undefined,
  );
  if (status?.phase !== "queued") {
    return null;
  }
  return {
    runId: status.runId,
    provider: status.provider,
    model: status.model,
    priority: status.priority,
    ...(status.position !== undefined ? { position: status.position } : {}),
  };
}

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

/**
 * The live turn-status header projection (plan 50): the ONE pinned status line's data for the
 * in-flight turn, or `undefined` when no turn is active (there is nothing to pin). The composed shape
 * is the semantic `headline` (the WHAT - the in-progress task, else the engine action), the `startedAt`
 * for the elapsed cell, the live `outputTokens` (the `↓` cell, absent until the first progress
 * snapshot), and the engine `state` (the HOW). `state` is always supplied when present; the
 * presentational `TurnStatusHeader` owns the redundancy rule that drops it when it equals the headline.
 */
export interface TurnStatusHeaderData {
  readonly headline: string;
  readonly startedAt?: number;
  readonly outputTokens?: number;
  readonly state?: string;
}

/**
 * Whether a turn is in flight for the pinned status header (plan 50): an active run OR the awaiting gap
 * between a submitted prompt and its `assistant.started`. The SINGLE active-turn predicate that header
 * presence keys off - it is also what the retired scrolling `working` row used, so the pinned header
 * and the interrupt affordance beside it can never drift apart (R-4). `awaitingResponse` is passed in
 * because it depends on the coalesced transcript tail (the last message being a user turn), which the
 * raw event fold here does not reconstruct.
 */
export function isTurnActive(events: readonly SessionEvent[], awaitingResponse: boolean): boolean {
  return activeTurnRunId(events) !== null || awaitingResponse;
}

/**
 * The active run's engine evidence for `turnActionLabel`: warmth + model ref from its
 * `assistant.started`, and `streaming` once it has emitted any assistant text. Empty (cold, unnamed,
 * not streaming) when no run is in flight - the awaiting gap, where the engine label degrades to the
 * `Working` fallback. Steering is not reconstructed web-side, so it is left unset here.
 */
function activeTurnEvidence(
  events: readonly SessionEvent[],
  runId: string | null,
): TurnActionEvidence {
  let warm = false;
  let model = "";
  let streaming = false;
  if (runId) {
    for (const event of events) {
      const decoded = decodeTrevorEvent(event);
      if (!decoded) {
        continue;
      }
      if (decoded.type === "assistant.started" && decoded.runId === runId) {
        warm = decoded.warm;
        model = decoded.model;
      } else if (decoded.type === "assistant.delta" && decoded.runId === runId && decoded.text) {
        streaming = true;
      }
    }
  }
  return { warm, model, streaming };
}

/**
 * The newest tool still running in the active turn - a `tool.started` with no matching `tool.completed`
 * - as a present-progress verb via the shared `toolActionLabel` (so the header reads "reading
 * src/foo.ts", never re-deriving the verb vocabulary). `undefined` when no tool is mid-flight. Map
 * insertion order keeps the most-recently-started still-running call last.
 */
function runningToolLabel(
  events: readonly SessionEvent[],
  runId: string | null,
): string | undefined {
  if (!runId) {
    return undefined;
  }
  const running = new Map<string, { name: string; arguments: string }>();
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded || !("runId" in decoded) || decoded.runId !== runId) {
      continue;
    }
    if (decoded.type === "tool.started") {
      running.set(decoded.callId, { name: decoded.name, arguments: decoded.arguments });
    } else if (decoded.type === "tool.completed") {
      running.delete(decoded.callId);
    }
  }
  const newest = [...running.values()].at(-1);
  return newest ? toolActionLabel(newest.name, newest.arguments) : undefined;
}

/**
 * The live turn's output-token count for the `↓` cell: the MAX `assistant.progress` `usage.output`
 * within the in-flight turn, or `undefined` before the first snapshot / after completion. It shares
 * `liveCallFrom`'s live-turn boundary (walk back, stop at the first `assistant.completed`) but is
 * CLAMPED MONOTONIC - it takes the max rather than the newest, so an advisory dip in a later progress
 * snapshot can never regress the cell within a turn (D-002/R-3).
 */
function liveOutputTokens(events: readonly SessionEvent[]): number | undefined {
  let max: number | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const decoded = event ? decodeTrevorEvent(event) : null;
    if (!decoded) {
      continue;
    }
    if (decoded.type === "assistant.completed") {
      break;
    }
    if (decoded.type === "assistant.progress" && decoded.usage) {
      const out = decoded.usage.output;
      max = max === undefined ? out : Math.max(max, out);
    }
  }
  return max;
}

/**
 * The pinned live turn-status header (plan 50), composed from primitives already on the wire.
 * `undefined` when no turn is active. Otherwise: the `headline` is the in-progress task's
 * present-progressive `activeForm` (the WHAT), falling back to the engine `state` when no task is
 * active; the `state` (the HOW) is a running tool's verb, else the `turnActionLabel` engine phase
 * (thinking/streaming/loading/Working); `startedAt` drives the elapsed cell; `outputTokens` is the live
 * monotonic output count (hidden until the first progress snapshot). This is the one projection - the
 * component only renders it and owns the redundancy/hidden-cell rendering rules.
 */
export function turnStatusHeaderFrom(
  events: readonly SessionEvent[],
  { awaitingResponse }: { readonly awaitingResponse: boolean },
): TurnStatusHeaderData | undefined {
  if (!isTurnActive(events, awaitingResponse)) {
    return undefined;
  }
  const runId = activeTurnRunId(events);
  const state =
    runningToolLabel(events, runId) ?? turnActionLabel(activeTurnEvidence(events, runId));
  const inProgress = tasksFrom(events).find((task) => task.status === "in_progress");
  const startedAt = activeTurnStartedAt(events);
  const outputTokens = liveOutputTokens(events);
  return {
    headline: inProgress?.activeForm ?? state,
    ...(startedAt !== null ? { startedAt } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    state,
  };
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
 * Orphaned-background reconcile (plan 52). Three kinds of work can latch "running" forever when the host
 * that owns their completion signal dies before emitting it, each recovered in its own way but under ONE
 * liveness verdict so a live-but-slow host is never cut short:
 *   - TURN: `detectOrphanedTurn` -> `reconcileTurn` publishes a terminal `assistant.completed{interrupted}`
 *     (mirrors the host's `reapExcept`).
 *   - SUBAGENT: `detectOrphanedSubagents` -> `reconcileSubagent` publishes a terminal
 *     `delegated.to{interrupted}` keyed by `childSessionId` (mirrors the host's `reapOrphanSubagents`);
 *     a background child outlives its turn, so it is recovered independently.
 *   - JOB: `jobsFrom` downgrades a `running` job to `interrupted` in the DERIVE layer only - a promoted
 *     shell job carries no durable per-job event, so it cannot publish a terminal link the way a turn or
 *     subagent does; the only available truth is that its `host.online` author is no longer the live
 *     leader (D-003), a pure presentation fix that emits nothing.
 * The turn + subagent detectors share {@link orphanRecoveryWindow}; the job downgrade reuses `hostStatus`'s
 * leader verdict. `interrupted` (recovered) stays distinct from `failed` (a genuine error) throughout.
 */

/**
 * The shared orphan-recovery GATE (plan 52 REFACTOR): the browser may step in to close orphaned
 * background work ONLY when no leader host is connected to ever write the terminal event, the view is
 * live + replayed (not a partial/stale log), and the log has been silent past `graceMs` (so a host that
 * is merely mid-reconnect gets first crack at its OWN reconcile before the browser does). Returns how
 * long the log has been silent when the gate is open, else null. Both {@link detectOrphanedTurn} and
 * {@link detectOrphanedSubagents} read this one predicate, so a live-but-slow host is never cut short by
 * either path. <!-- D-001 -->
 */
function orphanRecoveryWindow(events: readonly SessionEvent[], check: OrphanCheck): number | null {
  if (check.leaderPresent || !check.connected) {
    return null;
  }
  const lastAt = lastEventAt(events);
  if (lastAt === null) {
    return null;
  }
  const silentMs = check.now - lastAt;
  return silentMs >= check.graceMs ? silentMs : null;
}

/**
 * Detects an in-flight turn that is ORPHANED - one with no terminal event, while no leader host is
 * connected to ever write one. This is the client-side mirror of the host's reap-on-reconnect
 * (turn-machine `reapExcept`): when a host restarts/crashes mid-turn, or the host<->store socket
 * flapped exactly at turn-end, and nothing rejoins to win the lease, no host will EVER emit the
 * `assistant.completed` - so the "Working" spinner latches forever. The browser may then close the
 * turn itself, but only when it is certain no host can (the shared {@link orphanRecoveryWindow} gate).
 * Returns the orphaned run, or null.
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
  if (!runId) {
    return null;
  }
  const silentMs = orphanRecoveryWindow(events, check);
  return silentMs === null ? null : { runId, silentMs };
}

/** An orphaned background subagent the browser can recover: the original running `delegated.to` link's
 *  fields, so the reconcile can advance the EXISTING transcript block (keyed by `childSessionId`) to
 *  interrupted rather than spawn a second card. <!-- D-001 --> */
export interface OrphanedSubagent {
  readonly childSessionId: string;
  readonly runId: string;
  readonly agent: string;
  readonly task: string;
  readonly mode: "inline" | "background";
}

/**
 * Detects background subagents that are ORPHANED - a `delegated.to{status:"running"}` link on the parent
 * log with no terminal link for the same `childSessionId`, while no leader host is connected to ever fold
 * one back. The subagent analogue of {@link detectOrphanedTurn}: a background child OUTLIVES its spawning
 * turn, so its terminal link can be lost independently of any turn (its owning host crashed before the
 * fold-back), leaving the child stuck "running" forever. Gated by the SAME conservative window as the turn
 * detector (no leader + live replayed view + silent past grace), so a live-but-slow host finishes its own
 * children first. Returns every orphaned child's link (there may be several fanned out at once), or []. <!-- D-001 -->
 */
export function detectOrphanedSubagents(
  events: readonly SessionEvent[],
  check: OrphanCheck,
): readonly OrphanedSubagent[] {
  if (orphanRecoveryWindow(events, check) === null) {
    return [];
  }
  const running = new Map<string, OrphanedSubagent>();
  const terminated = new Set<string>();
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (decoded?.type !== "delegated.to") {
      continue;
    }
    if (isTerminalDelegationStatus(decoded.status)) {
      terminated.add(decoded.childSessionId);
    } else {
      running.set(decoded.childSessionId, {
        childSessionId: decoded.childSessionId,
        runId: decoded.runId,
        agent: decoded.agent,
        task: decoded.task,
        mode: decoded.mode === "background" ? "background" : "inline",
      });
    }
  }
  const out: OrphanedSubagent[] = [];
  for (const [childSessionId, link] of running) {
    if (!terminated.has(childSessionId)) {
      out.push(link);
    }
  }
  return out;
}

/** The orphaned subagents still needing a reconcile: the detected orphans not yet in `reconciled` (the
 *  app's `reconciledSubagentRef` Set). Mirrors the turn path's `reconciledRunRef` one-shot guard so each
 *  child publishes at most one interrupted link even as the detector keeps returning it every clock
 *  tick. Pure, so the once-per-child wiring policy is testable without rendering the app. <!-- D-001 --> */
export function unreconciledSubagents(
  detected: readonly OrphanedSubagent[],
  reconciled: ReadonlySet<string>,
): readonly OrphanedSubagent[] {
  return detected.filter((orphan) => !reconciled.has(orphan.childSessionId));
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
