import {
  type ArtifactRef,
  activeTurnRunId,
  addBreakdown,
  type CommandMenuPayload,
  decodeTrevorEvent,
  inputEstimateTokens,
  isInlineAgentDelegation,
  isTerminalDelegationStatus,
  type LimitStatus,
  lucidArtifactRef,
  type ModelSwitchEndpoint,
  type ModelSwitchInitiator,
  type ModelSwitchOutcome,
  type PastePayload,
  type ProviderDiagnostic,
  type ProviderQuestionAnswer,
  type ProviderQuestionContract,
  queuedFollowUps,
  READ_ONLY_TOOL_NAMES,
  type SessionEvent,
  supersededMessageIds,
  type TurnStop,
  timeUntil,
  type Usage,
  type UsageBreakdown,
} from "@trevor/session";
import { type QuestionOutcome, summarizeProviderQuestion } from "./derive";
import { type QueuedPrompt, queuedPromptsFrom } from "./send-queue";

export type { ArtifactRef, PastePayload, Usage, UsageBreakdown };

// One assistant *segment*: the run of thinking/text between tool calls. A turn that
// calls tools produces several, interleaved with tool messages in arrival order.
export type AssistantMessage = {
  kind: "assistant";
  id: string;
  runId: string;
  text: string;
  thinking: string;
  done: boolean;
  warm: boolean;
  model: string;
  provider?: string;
  usage?: Usage;
  breakdown?: UsageBreakdown;
  error?: string;
  overflow?: string;
  cancelled?: boolean;
  /** Closed by a host reap (restart/crash mid-turn), not a user cancel - rendered as a muted note. */
  interrupted?: boolean;
  /** Closed by the user steering (Esc with queued prompts). Rendered as a muted "steered" note. */
  steered?: boolean;
  /** The model ended the turn with no reply (after a retry). */
  noReply?: boolean;
  /** Steps run when the turn hit its budget (>0 = a forced answer after the step/context cap). */
  stepLimit?: number;
  stop?: TurnStop;
  /** The structured provider incident on a terminal completion (D-005): present on a malformed-protocol
   *  anomaly so the row can render the leaked markup escaped instead of as ordinary markdown. */
  diagnostic?: ProviderDiagnostic;
};
export type ToolMessage = {
  kind: "tool";
  id: string;
  name: string;
  args: string;
  done: boolean;
  /** True when the run ended (cancel/interrupt/error) before this tool produced its own
   *  `tool.completed` - so a concurrently-dispatched read-only tool never hangs on "running" after
   *  ESC. Rendered as the error/aborted state, never a successful "done". */
  aborted?: boolean;
  /** The tool's rendered output (from tool.completed), used by renderers like web_search. */
  result?: string;
};
// The host's result for an immediate slash command (the command lane - these never go to the model,
// so they render on their own, not as assistant turns). The command itself is not listed; only its
// result is shown (the output the user invoked).
export type CommandResultMessage = {
  kind: "result";
  id: string;
  command: string;
  text: string;
  ok: boolean;
  /** A host-owned nested command menu (plan 03) rendered inline; absent for plain text results. */
  menu?: CommandMenuPayload;
};
// A graceful-overflow-recovery adjustment, rendered inline as a status marker: the
// loop recovered (trimmed a tool result / reduced thinking) and retried. Distinct from
// compaction (durable history summarization, D-036, not yet built).
export type RecoveredMessage = {
  kind: "recovered";
  id: string;
  action: string;
  detail: string;
  reclaimed: number;
};
// A step-budget CHECKPOINT auto-continue (02.17), rendered inline as a QUIET breadcrumb: the loop
// reached the adaptive step budget with context headroom + progress, so it continued past it instead of
// pausing. Distinct from the alarming `step_backstop` pause card, which renders only on a genuine
// terminating stop. `steps` is where it continued, `pressure` the context fraction (0..1).
export type ContinuedMessage = {
  kind: "continued";
  id: string;
  steps: number;
  pressure: number;
  detail: string;
};
// A transient provider outage being auto-retried before any token streamed (D-076…D-079),
// rendered inline as a status marker: the stream dropped and the loop is reconnecting. `attempt`
// is the 1-based retry number (of MAX_RECONNECT_ATTEMPTS). Distinct from `recovered` (context
// pressure) - this is a transport fault.
export type ReconnectingMessage = {
  kind: "reconnecting";
  id: string;
  attempt: number;
  /** Total attempt budget for the denominator; absent on pre-02.15 logs (falls back below). */
  maxAttempts?: number;
  detail: string;
};
/** Denominator for a reconnecting marker whose log predates the threaded `maxAttempts` (02.15). Those
 *  logs were written under a 3-attempt budget, so a replayed `attempt/3` stays accurate. */
export const LEGACY_RECONNECT_ATTEMPTS = 3;
// A tool-call guardrail marker (plan 07), rendered inline as a quiet status: the per-turn controller
// flagged a repeating tool path (a repeated exact failure, or a read-only call returning the same
// result with no progress). REDACTED by construction - only the tool name, the decision action, the
// reason code, and the repeat count, never the raw arguments, output, or fingerprints. The model-facing
// guidance rides the tool result, not this marker.
export type GuardrailMessage = {
  kind: "guardrail";
  id: string;
  tool: string;
  action: string;
  reason: string;
  count: number;
};
// A cross-turn compaction fold IN PROGRESS (D-040), rendered inline as a TRANSIENT progress bar:
// older turns are being folded into a rolling summary, which streams. `tokens`/`budget` fill the
// bar honestly (real tokens streamed ÷ the ~1k budget, never a predicted %). It appears while the
// fold runs and VANISHES when the matching `context.compacted` lands - the folded turns themselves
// stay in the transcript (full history retained, D-042). Distinct from `recovered` (within-turn).
export type CompactingMessage = {
  kind: "compacting";
  id: string;
  foldId: string;
  tokens: number;
  budget: number;
};
// A subagent delegation (D-046..D-048), rendered inline as a distinct linked block: a `delegated.to`
// event names the child session, the agent, the task, and a status that advances running -> done
// /failed. `result` is the child's distilled final message once it folds back. The web reduces the
// running + terminal links for one child to this single block (keyed by `childSessionId`), so it
// shows progress then the result, not two cards. Distinct from an ordinary tool card.
export type DelegationMessage = {
  kind: "delegation";
  id: string;
  childSessionId: string;
  agent: string;
  task: string;
  mode: string;
  status: string;
  result?: string;
};
// A blocking INLINE delegation (`delegate_inline`, plan 09.4), rendered as a compact inline-agent row
// rather than the purple background block above. One assistant message can spawn several inline
// children (the host runs tool calls at `toolConcurrency`), so the `delegated.to{mode:"inline"}` links
// are grouped by `parentRunId` (the parent turn's runId) into ONE block; within it each child is an
// entry keyed by `childSessionId`, advanced running -> terminal in place. `model`/`reasoningLevel`/
// `tokens` are the live metadata the host stamps + mirrors onto the parent link (M2), and `startedAt`
// is the running link's own timestamp - so the row renders from the parent log with NO child-session
// subscription. Background delegation keeps the `delegation` block above.
export type InlineAgentStatus = "running" | "done" | "failed" | "interrupted";
export type InlineAgent = {
  childSessionId: string;
  agent: string;
  model?: string;
  reasoningLevel?: string;
  /** Ms epoch of the running link - drives the row's live elapsed cell while running. */
  startedAt?: number;
  tokens?: number;
  status: InlineAgentStatus;
};
export type InlineAgentMessage = {
  kind: "inlineAgent";
  id: string;
  parentRunId: string;
  agents: InlineAgent[];
};
/** Narrows a decoded (permissive-string) delegation status to the inline-agent union; an unknown or
 *  absent status is treated as still-running, since only the three terminals close a link. */
function asInlineAgentStatus(status: string): InlineAgentStatus {
  return status === "done" || status === "failed" || status === "interrupted" ? status : "running";
}
// Tools whose transcript presence is a PURPOSE-BUILT message, not a tool card, so their raw
// tool.started/completed/guardrail rows are suppressed: `ask_user` renders as the live QuestionSurface
// (D-001); `delegate_inline`/`delegate_background` render as their `delegated.to` link - an inline-
// agent row or the background block (plan 09.4) - so the delegation is never shown twice.
const SUPPRESSED_TOOL_ROWS = new Set(["ask_user", "delegate_inline", "delegate_background"]);
// Task tools mutate the task snapshot consumed by the support panel. They should act without
// transcript presence, including avoiding the assistant segment split that visible tools need.
const INVISIBLE_TOOL_ROWS = new Set(["task_create", "task_update", "task_list"]);
const HIDDEN_TOOL_ROWS = new Set([...SUPPRESSED_TOOL_ROWS, ...INVISIBLE_TOOL_ROWS]);
// A prompt-shell-lane run (D-082): a leading `!` published a `user.shell`, and the leader's
// `shell.result` carries the output. The web reduces the pair (keyed by `requestId`) to one terminal
// block - pending while only the request is in, then the output once the result lands. `ok` is false
// for a refused / failed command. Never fed to the model; rendered distinctly from a command result.
export type ShellMessage = {
  kind: "shell";
  id: string;
  requestId: string;
  command: string;
  done: boolean;
  output?: string;
  ok?: boolean;
};
// A resolved `ask_user` interaction (D-001): the slim transcript record of what Trevor asked and how
// the user answered, folded from `provider.question.requested` + `.answer` + `.resolved` (paired by
// questionId). The raw `ask_user` tool row stays hidden; this is a purpose-built message, created on
// the resolved event and updated in place if a duplicate/late resolved arrives. `items` carries one
// question/answer pair per asked question; `summary` is the one-line compact form.
export type QuestionMessage = {
  kind: "question";
  id: string;
  questionId: string;
  runId: string;
  outcome: QuestionOutcome;
  items: readonly { readonly id: string; readonly question: string; readonly answer: string }[];
  summary: string;
};
// A visible hook decision (plan 25 M9), rendered inline as a quiet attributed line: a PreToolUse
// hook denied a tool, a Stop hook halted the finalizing turn, or a hook injected bounded context.
// Only those three verbs get a transcript row - updated_input/continuation ride their visible
// effects (the rewritten call, the continued text) and the diagnostic verbs (timeout/error/
// unapproved/trust_changed) belong to /doctor. `reason` is redacted on the host at decision
// parse (every host surface carries the redacted form by construction) and re-redacted +
// bounded at the event fold.
export type HookDecisionMessage = {
  kind: "hookDecision";
  id: string;
  /** The hook's approval key (`user:<id>`, or `project:<workspace root>:<id>`). */
  hookId: string;
  /** "PreToolUse" | "Stop" (open for forward-compat gates). */
  event: string;
  /** "deny" | "halt" | "context" - the only verbs that render inline. */
  decision: string;
  toolName?: string;
  reason?: string;
};
/** The hook.decision verbs that render as transcript rows (plan 25 M9). */
export const RENDERED_HOOK_DECISIONS: ReadonlySet<string> = new Set(["deny", "halt", "context"]);

/** The one-line action label for a rendered hook decision ("denied bash" / "halted the turn" /
 *  "context for read"), shared by the full transcript row and its compact form so the two
 *  surfaces cannot drift. */
export function hookDecisionActionLabel(decision: string, toolName?: string): string {
  return decision === "deny"
    ? `denied ${toolName ?? "a tool"}`
    : decision === "halt"
      ? "halted the turn"
      : `context${toolName ? ` for ${toolName}` : ""}`;
}
// A mid-turn model/reasoning switch (plan 09.1), rendered inline as a quiet breadcrumb: the active turn
// changed model and/or reasoning at a step boundary. `from`/`to` carry the model id + reasoning so the
// delta renders, including a reasoning-only change (same model on both sides). A `blocked` outcome (the
// larger->smaller context guard refused) renders the reason instead of a delta.
export type ModelSwitchMessage = {
  kind: "modelSwitch";
  id: string;
  from: ModelSwitchEndpoint;
  to: ModelSwitchEndpoint;
  initiator: ModelSwitchInitiator;
  outcome: ModelSwitchOutcome;
  reason?: string;
};

// A published LUCID artifact (plan 27, M2/M7): an addressable HTML artifact the agent produced, shown
// as a transcript card that OPENS it in the artifact panel (never a separate `lucid open` tab).
// Coalesced per stable `lucidId` to the latest version, so a re-publish updates one card in place
// rather than stacking a new card per revision.
export type LucidArtifactMessage = {
  kind: "lucid";
  id: string;
  lucidId: string;
  title: string;
  version: number;
  /** The panel-openable artifact ref (carries the `lucid` marker), built from the publish event. */
  artifact: ArtifactRef;
};

/** One side of a switch as `model (reasoning)`, or just `model` when no level applies - shared by the
 *  transcript breadcrumb and its compact row so the two surfaces can't drift. */
export function formatSwitchEndpoint(endpoint: ModelSwitchEndpoint): string {
  return endpoint.reasoning ? `${endpoint.model} (${endpoint.reasoning})` : endpoint.model;
}

// A provider usage-limit signal (plan 44.4), folded from `assistant.limit`: the session is approaching
// or has reached a provider rate/usage window (Claude's unified rate-limit headers, a terminal Codex
// 429). `approaching` renders as a quiet muted breadcrumb (like the model-switch marker); `reached`
// renders as a louder alert (like `recovered`). `resetsAt` (unix epoch SECONDS) and `utilization`
// (0..1) ride only when the provider exposed them. Detection only - it never pauses or switches anything.
export type LimitMessage = {
  kind: "limit";
  id: string;
  provider: string;
  status: LimitStatus;
  scope: string;
  resetsAt?: number;
  utilization?: number;
};

/** A usage-limit window id as a compact label - the known Anthropic windows read nicely; an unknown or
 *  window-less scope reads as a generic "usage". Shared by the full row and its compact form. */
export function formatLimitScope(scope: string): string {
  switch (scope) {
    case "five_hour":
      return "5h window";
    case "seven_day":
      return "7d window";
    case "seven_day_opus":
      return "7d Opus window";
    case "unified":
    case "unknown":
      return "usage";
    default:
      return scope;
  }
}

/** The one-line summary of a usage-limit marker (`provider · window[ · resets in X][ · N% used]`),
 *  shared by the full row and its compact form so the two surfaces can't drift. `nowMs` is injected so
 *  the humanized `resetsAt` (via `timeUntil`) is deterministic in tests. */
export function limitMarkerSummary(message: LimitMessage, nowMs: number): string {
  const parts = [message.provider, formatLimitScope(message.scope)];
  if (message.resetsAt !== undefined) {
    parts.push(`resets ${timeUntil(message.resetsAt, nowMs)}`);
  }
  if (message.utilization !== undefined) {
    parts.push(`${Math.round(message.utilization * 100)}% used`);
  }
  return parts.join(" · ");
}

const RECONNECT_DETAIL_MAX = 96;
const RECONNECT_STATUS_PHRASE =
  /\b(?:HTTP\s*)?(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|500 Internal Server Error|Bad Gateway|connection reset|websocket closed)\b/i;

function capReconnectDetail(text: string): string {
  return text.length <= RECONNECT_DETAIL_MAX
    ? text
    : `${text.slice(0, RECONNECT_DETAIL_MAX - 3).trimEnd()}...`;
}

export function reconnectDisplayDetail(detail: string): string {
  const withoutBlocks = detail
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const hadTags = /<\/?[a-z][^>]*>/i.test(withoutBlocks);
  const plain = withoutBlocks
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (hadTags) {
    return plain.match(RECONNECT_STATUS_PHRASE)?.[0] ?? "connection dropped";
  }
  return capReconnectDetail(plain || "connection dropped");
}
export type Message =
  | {
      kind: "user";
      id: string;
      text: string;
      artifacts: readonly ArtifactRef[];
      /** Exact pasted payloads paired to the prompt's `[Pasted text #N +M lines]` tokens, in reading
       *  order, for transcript inspect/copy. `[]` on a legacy message with no pastes. */
      pastes: readonly PastePayload[];
    }
  | AssistantMessage
  | ToolMessage
  | CommandResultMessage
  | RecoveredMessage
  | ContinuedMessage
  | ReconnectingMessage
  | GuardrailMessage
  | CompactingMessage
  | DelegationMessage
  | InlineAgentMessage
  | ShellMessage
  | QuestionMessage
  | HookDecisionMessage
  | ModelSwitchMessage
  | LimitMessage
  | LucidArtifactMessage;

/**
 * Finds the concurrent read-only batches in a transcript: each run of 2+ consecutive read-only tool
 * messages. Returns a map from the run's first message id to the whole run (rendered together at
 * that row), and the set of continuation ids to skip while mapping (they're drawn inside the batch).
 * A lone read-only tool, or one broken from the run by a mutating tool / assistant segment, is not a
 * batch and renders as its usual card.
 */
export function readOnlyToolBatches(messages: readonly Message[]): {
  readonly batchAt: ReadonlyMap<string, readonly ToolMessage[]>;
  readonly skip: ReadonlySet<string>;
} {
  const batchAt = new Map<string, readonly ToolMessage[]>();
  const skip = new Set<string>();
  let i = 0;
  while (i < messages.length) {
    const head = messages[i];
    if (head?.kind === "tool" && READ_ONLY_TOOL_NAMES.has(head.name)) {
      const run: ToolMessage[] = [];
      while (i < messages.length) {
        const next = messages[i];
        if (next?.kind === "tool" && READ_ONLY_TOOL_NAMES.has(next.name)) {
          run.push(next);
          i += 1;
        } else {
          break;
        }
      }
      const first = run[0];
      if (first && run.length >= 2) {
        batchAt.set(first.id, run);
        for (let k = 1; k < run.length; k += 1) {
          const continuation = run[k];
          if (continuation) {
            skip.add(continuation.id);
          }
        }
      }
    } else {
      i += 1;
    }
  }
  return { batchAt, skip };
}

/** A live, mid-turn snapshot of the in-flight call: usage drives the ctx meter, the
 *  breakdown drives the Request treemap, both before the turn completes. */
export interface LiveCall {
  readonly usage: Usage;
  readonly breakdown?: UsageBreakdown;
}

function displayInputTokens(
  usage: Usage | undefined,
  breakdown: UsageBreakdown | undefined,
): number | undefined {
  const estimated = breakdown ? inputEstimateTokens(breakdown) : undefined;
  if (!usage) {
    return estimated;
  }

  return estimated === undefined ? usage.input : Math.max(usage.input, estimated);
}

/**
 * The in-flight snapshot for the panel: the newest `assistant.progress` from a turn
 * that hasn't completed yet, or `undefined` once the latest turn has finished (so
 * callers fall back to the completed call's authoritative usage + breakdown). Walks
 * back from the newest event and stops at the first completion - a progress seen
 * before any completion means a turn is still streaming.
 */
export function liveCallFrom(events: readonly SessionEvent[]): LiveCall | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const decoded = event ? decodeTrevorEvent(event) : null;
    if (!decoded) {
      continue;
    }
    if (decoded.type === "assistant.completed") {
      return undefined;
    }
    if (decoded.type === "assistant.progress" && decoded.usage) {
      return { usage: decoded.usage, breakdown: decoded.breakdown };
    }
  }
  return undefined;
}

/**
 * The user.message eventIds the transcript hides for the durable follow-up queue (plan 47): a prompt
 * SUPERSEDED (folded / unqueued / recalled - retracted, so it never ran) and the visible queued
 * follow-ups behind the current turn/awaiting prompt (rendered by the queue panel, not duplicated in the
 * main flow). Kept scoped so a single ordinary awaiting prompt renders normally.
 */
export function queuedOrSupersededUserIds(
  events: readonly SessionEvent[],
  selfProducerId?: string,
): Set<string> {
  const hidden = supersededMessageIds(events);
  for (const queued of queuedFollowUps(events, selfProducerId)) {
    hidden.add(queued.eventId);
  }
  return hidden;
}

/**
 * Coalesces the raw event log into a transcript in arrival order. An assistant turn
 * is split into segments at each tool call: the open segment is finalized when a tool
 * starts, so thinking/text that comes *after* a tool renders below it (not lumped into
 * one bubble at the top). started only records the run's model/warmth; a segment is
 * created lazily on the first thinking/text, so an empty turn never leaves a stray bubble.
 * Payloads are read through decodeTrevorEvent, so the fold never hand-guards raw fields.
 *
 * Durable follow-up queue (plan 47): a prompt superseded (folded/unqueued) or still queued behind the
 * current turn/awaiting prompt is hidden here - the queue panel renders it instead - so a
 * published-but-not-yet-run follow-up never double-renders. `selfProducerId` excludes the host's own
 * echoes from that queue view.
 */
/** The mutable working state of the transcript fold: the message list plus the per-run/-tool/-fold
 *  bookkeeping the reducer threads across events, and `apply` to fold one more event into it. `dirty`
 *  records which already-emitted messages a batch mutated, so the incremental {@link TranscriptProjector}
 *  can give changed rows a fresh identity while unchanged rows keep theirs (structural sharing). It is
 *  inert for the one-shot {@link toTranscript}. */
export interface TranscriptFold {
  readonly messages: Message[];
  readonly dirty: Set<Message>;
  readonly apply: (event: SessionEvent) => void;
}

function createTranscriptFold(): TranscriptFold {
  const messages: Message[] = [];
  // The messages a batch mutated in place (streaming segment, a tool completing, an in-flight block
  // advancing). The projector re-clones exactly these so their row re-renders while every untouched row
  // keeps its object identity - the precondition for the per-row React.memo boundaries.
  const dirty = new Set<Message>();
  const touch = <T extends Message>(message: T): T => {
    dirty.add(message);
    return message;
  };
  const runMeta = new Map<string, { model: string; warm: boolean; provider?: string }>();
  const openByRun = new Map<string, AssistantMessage>();
  const lastByRun = new Map<string, AssistantMessage>();
  const toolByCall = new Map<string, ToolMessage>();
  // The tools dispatched per run, and the runs that have already terminated. Together they finalize a
  // tool that never got its own `tool.completed` because the run was cancelled/interrupted mid-flight
  // (a concurrently-dispatched read-only tool like session_recall): on the run's terminal completion
  // every still-open tool is marked aborted, and a LATE `tool.started` that races in after the
  // completion (the cancel publishes the completion first, then the fiber emits one more start) is
  // marked aborted on arrival. Without this the transcript shows that tool "running" forever.
  const toolsByRun = new Map<string, ToolMessage[]>();
  const terminatedRuns = new Set<string>();
  // The latest live usage/breakdown per run (from assistant.progress). A cancelled turn's completion
  // carries no usage, so without this its panel data (ctx meter + Request treemap) would vanish on
  // cancel; we fall the segment back to its last progress snapshot so the current context survives.
  const progressByRun = new Map<string, { usage?: Usage; breakdown?: UsageBreakdown }>();
  // In-flight compaction folds: the live progress bar keyed by foldId, plus the folds already
  // finished (so a late `context.compacting` tick that arrives after `context.compacted` is ignored
  // rather than re-spawning a bar that should have vanished).
  const compactingByFold = new Map<string, CompactingMessage>();
  const doneFolds = new Set<string>();
  // One linked block per delegated child, keyed by childSessionId; the running + terminal
  // `delegated.to` links advance the same block in place (status + result), never two cards.
  const delegationByChild = new Map<string, DelegationMessage>();
  // Inline delegations (plan 09.4): one `inlineAgent` block per PARENT turn (keyed by parentRunId)
  // groups that turn's parallel inline children; each child is an entry keyed by childSessionId,
  // advanced running -> terminal in place (the grouped analogue of the delegation block above).
  const inlineAgentByParent = new Map<string, InlineAgentMessage>();
  const inlineAgentEntryByChild = new Map<string, InlineAgent>();
  // Retry attempts update in place so a transient provider outage does not flood the transcript.
  const reconnectingByRun = new Map<string, ReconnectingMessage>();
  // One terminal block per shell-lane run (D-082), keyed by requestId: the `user.shell` spawns a
  // pending block, the `shell.result` fills it in place (so it shows `$ command` then the output,
  // never two rows). A `shell.result` with no prior request (the request was compacted out of the
  // tail, or arrived first) still renders from its own command.
  const shellByRequest = new Map<string, ShellMessage>();
  // Resolved ask_user interactions (D-001): the request's contract and the user's answer are stashed
  // by questionId until the `provider.question.resolved` event folds them into one `question` message.
  // The raw ask_user tool row stays suppressed (see tool.started); this is the only thing the
  // interaction leaves in the transcript, and a duplicate/late resolved updates it in place.
  const questionContractById = new Map<string, ProviderQuestionContract>();
  const questionAnswerById = new Map<string, ProviderQuestionAnswer>();
  const questionMsgById = new Map<string, QuestionMessage>();
  // One card per stable lucidId (plan 27): a re-publish (a new version) updates the same card in place
  // rather than stacking a new card per revision, so the transcript shows one artifact, latest version.
  const lucidCardById = new Map<string, LucidArtifactMessage>();
  // Reaps every open fold bar from the transcript. A fold runs on the host's one-turn gate, so a
  // bar is only ever live at the tail; once a turn or command follows it without a matching
  // `context.compacted`, that fold was interrupted (host reset mid-fold) and its bar is an orphan -
  // drop it so it can't linger forever (and so a fresh fold never shows a second bar beside it).
  const reapCompacting = (): void => {
    for (const bar of compactingByFold.values()) {
      const index = messages.indexOf(bar);
      if (index >= 0) {
        messages.splice(index, 1);
      }
    }
    compactingByFold.clear();
  };
  let segCount = 0;
  const openSegment = (runId: string): AssistantMessage => {
    let segment = openByRun.get(runId);
    if (!segment) {
      const m = runMeta.get(runId);
      segment = {
        kind: "assistant",
        id: `${runId}:${segCount++}`,
        runId,
        text: "",
        thinking: "",
        done: false,
        warm: m?.warm ?? false,
        model: m?.model ?? "model",
        provider: m?.provider,
      };
      openByRun.set(runId, segment);
      lastByRun.set(runId, segment);
      messages.push(segment);
    }
    return segment;
  };
  const apply = (event: SessionEvent): void => {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      return;
    }
    switch (decoded.type) {
      case "user.cancel":
        // ESC during a manual /compact: the host interrupts the fold and emits no context.compacted,
        // so reap the bar here (it's the only signal that the fold ended). A no-op when no bar is open.
        reapCompacting();
        break;
      case "user.message":
        // A new prompt means any still-open fold bar was orphaned by a mid-fold reset - reap it.
        reapCompacting();
        // A superseded (folded/unqueued) prompt, or one still queued behind an in-flight turn, is
        // rendered by the queue panel, not the main flow (plan 47). A LATER event can supersede or claim
        // it, so the fold keeps it and the projection filters the hidden set at materialize time.
        messages.push({
          kind: "user",
          id: event.eventId,
          text: decoded.text,
          artifacts: decoded.artifacts,
          pastes: decoded.pastes,
        });
        break;
      case "user.command":
        // A fold never spans a command, so an open bar here is an orphan (reap it before the new
        // fold's first tick, so /compact can't show a stale bar above its fresh one).
        reapCompacting();
        if (decoded.command === "/clear") {
          // A clear resets the conversation: drop everything before it (and ALL in-flight run state)
          // so the transcript starts fresh from this point. The reapCompacting() above already dropped
          // any open fold bar and cleared compactingByFold; doneFolds is cleared here alongside it so
          // the one-compacting-bar singleton never reasons over stale folds after the reset.
          messages.length = 0;
          runMeta.clear();
          openByRun.clear();
          lastByRun.clear();
          toolByCall.clear();
          toolsByRun.clear();
          terminatedRuns.clear();
          progressByRun.clear();
          doneFolds.clear();
          delegationByChild.clear();
          inlineAgentByParent.clear();
          inlineAgentEntryByChild.clear();
          shellByRequest.clear();
          questionContractById.clear();
          questionAnswerById.clear();
          questionMsgById.clear();
          lucidCardById.clear();
        }
        // The command itself is NOT listed in the transcript - the user just typed it, so echoing it
        // back is noise. Only its result (command.result, below) is shown: the output they invoked.
        break;
      case "command.result":
        // A successful /clear moves to a new session, so its success chip is noise while the browser
        // follows `session.switch`. A failure stays visible in the old, cleared view.
        if (decoded.command === "/clear" && decoded.ok) {
          break;
        }
        // A /compact result means its fold is definitively over. On success the bar was already
        // reaped by `context.compacted`; on FAILURE (host restarted mid-fold) no such event ever
        // landed, so reap the orphaned bar here - otherwise it lingers and keeps animating above the
        // "Compaction interrupted" message. Gated to /compact so an unrelated command result landing
        // mid-fold (commands run off the one-turn gate) never kills a live bar.
        if (decoded.command === "/compact") {
          reapCompacting();
        }
        messages.push({
          kind: "result",
          id: event.eventId,
          command: decoded.command,
          text: decoded.text,
          ok: decoded.ok,
          ...(decoded.menu ? { menu: decoded.menu } : {}),
        });
        break;
      case "lucid.published": {
        const title = decoded.title ?? decoded.lucidId;
        const artifact = lucidArtifactRef({
          htmlHash: decoded.htmlHash,
          size: 0,
          meta: {
            lucidId: decoded.lucidId,
            version: decoded.version,
            provenance: decoded.provenance,
            reviewStatus: "open",
            ...(decoded.title ? { title: decoded.title } : {}),
          },
        });
        const existing = lucidCardById.get(decoded.lucidId);
        if (existing) {
          // A new version: update the same card in place (latest version + fresh artifact ref).
          touch(existing).version = decoded.version;
          existing.title = title;
          existing.artifact = artifact;
        } else {
          const card: LucidArtifactMessage = {
            kind: "lucid",
            id: event.eventId,
            lucidId: decoded.lucidId,
            title,
            version: decoded.version,
            artifact,
          };
          lucidCardById.set(decoded.lucidId, card);
          messages.push(card);
        }
        break;
      }
      case "user.shell": {
        // The shell-lane request: a pending terminal block (no output yet), keyed by requestId so its
        // result fills it in place. Already present means a duplicate request id - leave the block.
        if (!shellByRequest.has(decoded.requestId)) {
          const block: ShellMessage = {
            kind: "shell",
            id: event.eventId,
            requestId: decoded.requestId,
            command: decoded.command,
            done: false,
          };
          shellByRequest.set(decoded.requestId, block);
          messages.push(block);
        }
        break;
      }
      case "shell.result": {
        // Fill the pending block in place, or spawn a completed one if the request never landed (it
        // was compacted out of the tail, or the result arrived first). `command` falls back to the
        // result's own copy when the request is gone.
        const existing = shellByRequest.get(decoded.requestId);
        if (existing) {
          touch(existing).done = true;
          existing.output = decoded.output;
          existing.ok = decoded.ok;
        } else {
          const block: ShellMessage = {
            kind: "shell",
            id: event.eventId,
            requestId: decoded.requestId,
            command: decoded.command,
            done: true,
            output: decoded.output,
            ok: decoded.ok,
          };
          shellByRequest.set(decoded.requestId, block);
          messages.push(block);
        }
        break;
      }
      case "assistant.started":
        // A turn starting means any open fold already finished or was interrupted - reap a lingering
        // bar (this is what clears a lone orphan stuck at some % from a prior mid-fold reset).
        reapCompacting();
        runMeta.set(decoded.runId, {
          model: decoded.model,
          warm: decoded.warm,
          provider: decoded.provider,
        });
        break;
      case "assistant.delta":
        touch(openSegment(decoded.runId)).text += decoded.text;
        break;
      case "assistant.thinking":
        touch(openSegment(decoded.runId)).thinking += decoded.text;
        break;
      case "assistant.overflow":
        touch(openSegment(decoded.runId)).overflow = decoded.reason;
        break;
      case "assistant.progress":
        // Remember the turn's latest live usage/breakdown, so a cancel (whose completion carries
        // none) can keep showing the context it reached. Not rendered itself - only a fallback.
        if (decoded.usage || decoded.breakdown) {
          progressByRun.set(decoded.runId, {
            usage: decoded.usage,
            breakdown: decoded.breakdown,
          });
        }
        break;
      case "assistant.recovered": {
        // Finalize the open segment so the retry's output starts fresh below the marker.
        const open = openByRun.get(decoded.runId);
        if (open) {
          touch(open).done = true;
          openByRun.delete(decoded.runId);
        }
        messages.push({
          kind: "recovered",
          id: event.eventId,
          action: decoded.action,
          detail: decoded.detail,
          reclaimed: decoded.reclaimed,
        });
        break;
      }
      case "assistant.continued": {
        // A step-budget checkpoint auto-continued the turn (02.17): finalize the open segment so the
        // continued output starts fresh below the quiet breadcrumb.
        const open = openByRun.get(decoded.runId);
        if (open) {
          touch(open).done = true;
          openByRun.delete(decoded.runId);
        }
        messages.push({
          kind: "continued",
          id: event.eventId,
          steps: decoded.steps,
          pressure: decoded.pressure,
          detail: decoded.detail,
        });
        break;
      }
      case "model.switched": {
        // A mid-turn model/reasoning switch applied (or was blocked) at a step boundary (09.1): finalize
        // the open segment so the post-switch output starts fresh below the inline breadcrumb.
        const open = openByRun.get(decoded.runId);
        if (open) {
          touch(open).done = true;
          openByRun.delete(decoded.runId);
        }
        messages.push({
          kind: "modelSwitch",
          id: event.eventId,
          from: decoded.from,
          to: decoded.to,
          initiator: decoded.initiator,
          outcome: decoded.outcome,
          ...(decoded.reason ? { reason: decoded.reason } : {}),
        });
        break;
      }
      case "assistant.limit":
        // A provider usage-limit signal (plan 44.4): a standalone marker. Not run-scoped, so it does not
        // finalize an open assistant segment - it just marks the point the provider reported the limit.
        messages.push({
          kind: "limit",
          id: event.eventId,
          provider: decoded.provider,
          status: decoded.status,
          scope: decoded.scope,
          ...(decoded.resetsAt !== undefined ? { resetsAt: decoded.resetsAt } : {}),
          ...(decoded.utilization !== undefined ? { utilization: decoded.utilization } : {}),
        });
        break;
      case "assistant.reconnecting": {
        // Finalize any open segment so the reconnected attempt's output starts fresh below the
        // marker (a reconnect fires before any token, so usually nothing is open).
        const open = openByRun.get(decoded.runId);
        if (open) {
          touch(open).done = true;
          openByRun.delete(decoded.runId);
        }
        const marker = reconnectingByRun.get(decoded.runId);
        const detail = reconnectDisplayDetail(decoded.detail);
        if (marker) {
          touch(marker).attempt = decoded.attempt;
          if (decoded.maxAttempts != null) {
            marker.maxAttempts = decoded.maxAttempts;
          }
          marker.detail = detail;
        } else {
          const next: ReconnectingMessage = {
            kind: "reconnecting",
            id: `reconnecting:${decoded.runId}`,
            attempt: decoded.attempt,
            ...(decoded.maxAttempts != null ? { maxAttempts: decoded.maxAttempts } : {}),
            detail,
          };
          reconnectingByRun.set(decoded.runId, next);
          messages.push(next);
        }
        break;
      }
      case "delegated.to": {
        // An INLINE-AGENT delegation (plan 09.4, a `delegate_inline` tool call) reduces to a compact
        // inline-agent row grouped by the parent turn (parentRunId); a BACKGROUND child OR a workflow
        // leaf (which shares mode:"inline" but has its own rendering) keeps the linked block below.
        // Both collapse a child's running + terminal links into ONE entry keyed by childSessionId.
        if (isInlineAgentDelegation(decoded.mode, decoded.agent)) {
          const entry = inlineAgentEntryByChild.get(decoded.childSessionId);
          if (entry) {
            // A late fire-and-forget token mirror (status:"running") can arrive AFTER the awaited
            // terminal fold-back; never let it regress an already-terminal entry back to running.
            if (
              isTerminalDelegationStatus(entry.status) &&
              !isTerminalDelegationStatus(decoded.status)
            ) {
              break;
            }
            // The entry lives inside the parent group's `agents`; touch the group so the row re-clones.
            const parentGroup = inlineAgentByParent.get(decoded.runId);
            if (parentGroup) {
              touch(parentGroup);
            }
            entry.status = asInlineAgentStatus(decoded.status);
            if (decoded.model !== undefined) {
              entry.model = decoded.model;
            }
            if (decoded.reasoningLevel !== undefined) {
              entry.reasoningLevel = decoded.reasoningLevel;
            }
            if (decoded.tokens !== undefined) {
              entry.tokens = decoded.tokens;
            }
          } else {
            // First link for a child: `startedAt` is THIS (running) link's timestamp - the free live
            // clock the row's elapsed cell ticks from, no extra data on the wire (D-002).
            const startedAt = Date.parse(event.createdAt);
            const fresh: InlineAgent = {
              childSessionId: decoded.childSessionId,
              agent: decoded.agent,
              status: asInlineAgentStatus(decoded.status),
              ...(decoded.model !== undefined ? { model: decoded.model } : {}),
              ...(decoded.reasoningLevel !== undefined
                ? { reasoningLevel: decoded.reasoningLevel }
                : {}),
              ...(decoded.tokens !== undefined ? { tokens: decoded.tokens } : {}),
              ...(Number.isNaN(startedAt) ? {} : { startedAt }),
            };
            inlineAgentEntryByChild.set(decoded.childSessionId, fresh);
            const group = inlineAgentByParent.get(decoded.runId);
            if (group) {
              touch(group).agents.push(fresh);
            } else {
              const block: InlineAgentMessage = {
                kind: "inlineAgent",
                id: event.eventId,
                parentRunId: decoded.runId,
                agents: [fresh],
              };
              inlineAgentByParent.set(decoded.runId, block);
              messages.push(block);
            }
          }
          break;
        }
        // Background: first link for a child spawns the block; later links (done/failed, with the
        // result) advance the same block in place, so the UI shows one linked card per delegation.
        const existing = delegationByChild.get(decoded.childSessionId);
        if (existing) {
          touch(existing).status = decoded.status;
          if (decoded.result !== undefined) {
            existing.result = decoded.result;
          }
        } else {
          const block: DelegationMessage = {
            kind: "delegation",
            id: event.eventId,
            childSessionId: decoded.childSessionId,
            agent: decoded.agent,
            task: decoded.task,
            mode: decoded.mode,
            status: decoded.status,
            ...(decoded.result !== undefined ? { result: decoded.result } : {}),
          };
          delegationByChild.set(decoded.childSessionId, block);
          messages.push(block);
        }
        break;
      }
      case "context.compacting": {
        // A live fold tick: spawn the progress bar on the first tick, then advance it in place
        // (monotonic - a reordered tick never rewinds). Ignored once the fold has completed.
        if (doneFolds.has(decoded.foldId)) {
          break;
        }
        const existing = compactingByFold.get(decoded.foldId);
        if (existing) {
          touch(existing).tokens = Math.max(existing.tokens, decoded.tokens);
          existing.budget = decoded.budget;
        } else {
          // Singleton: a new fold supersedes any still-open (orphaned) bar from a prior fold, so
          // only one progress bar is ever on screen.
          reapCompacting();
          const bar: CompactingMessage = {
            kind: "compacting",
            id: decoded.foldId,
            foldId: decoded.foldId,
            tokens: decoded.tokens,
            budget: decoded.budget,
          };
          compactingByFold.set(decoded.foldId, bar);
          messages.push(bar);
        }
        break;
      }
      case "context.compacted": {
        // The fold finished: the live progress bar VANISHES (the folded turns stay in the
        // transcript - full history retained, D-042; only the model's PROMPT was compacted).
        doneFolds.add(decoded.foldId);
        const bar = compactingByFold.get(decoded.foldId);
        if (bar) {
          const index = messages.indexOf(bar);
          if (index >= 0) {
            messages.splice(index, 1);
          }
          compactingByFold.delete(decoded.foldId);
        }
        break;
      }
      case "tool.started": {
        if (INVISIBLE_TOOL_ROWS.has(decoded.name)) {
          break;
        }
        // Finalize the open segment so the next thinking/text starts a new one below the tool.
        const open = openByRun.get(decoded.runId);
        if (open) {
          touch(open).done = true;
          openByRun.delete(decoded.runId);
        }
        // ask_user (QuestionSurface) and the delegation tools (their delegated.to link) render as
        // purpose-built messages, not tool rows: suppress their tool.started/completed so they never
        // show as a tool block on top of their real surface.
        if (SUPPRESSED_TOOL_ROWS.has(decoded.name)) {
          break;
        }
        // A start that arrives AFTER its run already terminated (the cancel race) is aborted on
        // arrival; otherwise it joins the run's open-tool list so the completion can finalize it.
        const aborted = terminatedRuns.has(decoded.runId);
        const tool: ToolMessage = {
          kind: "tool",
          id: decoded.callId,
          name: decoded.name,
          args: decoded.arguments,
          done: aborted,
          ...(aborted ? { aborted: true } : {}),
        };
        toolByCall.set(decoded.callId, tool);
        if (!aborted) {
          const open = toolsByRun.get(decoded.runId);
          if (open) {
            open.push(tool);
          } else {
            toolsByRun.set(decoded.runId, [tool]);
          }
        }
        messages.push(tool);
        break;
      }
      case "tool.completed": {
        const tool = toolByCall.get(decoded.callId);
        if (tool) {
          touch(tool).done = true;
          // A real completion wins over a prior abort (defensive; an interrupted tool emits none).
          tool.aborted = false;
          tool.result = decoded.result;
        }
        break;
      }
      case "tool.guardrail": {
        // A redacted guardrail marker for the call that just ran (07): render it inline right after
        // its tool card. Hidden tools have no transcript row, so suppress their marker too.
        if (HIDDEN_TOOL_ROWS.has(decoded.name)) {
          break;
        }
        messages.push({
          kind: "guardrail",
          id: event.eventId,
          tool: decoded.name,
          action: decoded.action,
          reason: decoded.reason,
          count: decoded.count,
        });
        break;
      }
      case "hook.decision": {
        // A visible hook decision (plan 25 M9): only the deny/halt/context verbs render inline;
        // everything else (updated_input, continuation, the diagnostic states) has its own
        // surface (the rewritten call, the continued text, /doctor) and stays off the transcript.
        if (!RENDERED_HOOK_DECISIONS.has(decoded.decision)) {
          break;
        }
        messages.push({
          kind: "hookDecision",
          id: event.eventId,
          hookId: decoded.hookId,
          event: decoded.event,
          decision: decoded.decision,
          ...(decoded.toolName ? { toolName: decoded.toolName } : {}),
          ...(decoded.reason ? { reason: decoded.reason } : {}),
        });
        break;
      }
      case "assistant.completed": {
        // The run is terminal now: finalize any tool that never got its own completion (a read-only
        // tool still in flight when the user cancelled), so it stops rendering as "running". Marking
        // the run terminated also aborts a `tool.started` that races in after this completion.
        terminatedRuns.add(decoded.runId);
        for (const tool of toolsByRun.get(decoded.runId) ?? []) {
          if (!tool.done) {
            touch(tool).done = true;
            tool.aborted = true;
          }
        }
        toolsByRun.delete(decoded.runId);
        // Land the final state on the run's last segment (or a fresh one if the turn
        // produced nothing visible, so an error still has somewhere to show).
        const segment = touch(
          openByRun.get(decoded.runId) ??
            lastByRun.get(decoded.runId) ??
            openSegment(decoded.runId),
        );
        segment.done = true;
        openByRun.delete(decoded.runId);
        if (decoded.error) {
          segment.error = decoded.error;
        }
        if (decoded.cancelled) {
          segment.cancelled = true;
        }
        if (decoded.interrupted) {
          segment.interrupted = true;
        }
        if (decoded.steered) {
          segment.steered = true;
        }
        if (decoded.noReply) {
          segment.noReply = true;
        }
        if (decoded.stepLimit) {
          segment.stepLimit = decoded.stepLimit;
        }
        if (decoded.stop) {
          segment.stop = decoded.stop;
        }
        if (decoded.diagnostic) {
          segment.diagnostic = decoded.diagnostic;
        }
        if (!segment.text && !segment.thinking) {
          segment.text = decoded.text;
        }
        // Usage/breakdown from the completion when it carries them (a normal turn); otherwise fall
        // back to the run's last progress snapshot, so a cancelled turn (completion has none) keeps
        // the context it reached instead of blanking the panel to "No call data yet".
        const progress = progressByRun.get(decoded.runId);
        if (decoded.usage) {
          segment.usage = decoded.usage;
        } else if (progress?.usage) {
          segment.usage = progress.usage;
        }
        if (decoded.breakdown) {
          segment.breakdown = decoded.breakdown;
        } else if (progress?.breakdown) {
          segment.breakdown = progress.breakdown;
        }
        progressByRun.delete(decoded.runId);
        break;
      }
      case "provider.question.requested":
        // Stash the question contract; the live pending UI is owned by QuestionSurface
        // (pendingQuestionFrom). No transcript row until it resolves (M4).
        questionContractById.set(decoded.questionId, decoded.contract);
        break;
      case "provider.question.answer":
        questionAnswerById.set(decoded.questionId, decoded.answer);
        break;
      case "provider.question.resolved": {
        // Terminal: fold request + answer + outcome into one slim question message. A duplicate or
        // late resolved updates the existing row in place rather than appending a second one.
        const view = summarizeProviderQuestion({
          contract: questionContractById.get(decoded.questionId),
          answer: questionAnswerById.get(decoded.questionId),
          outcome: decoded.outcome,
          summary: decoded.summary,
        });
        const existing = questionMsgById.get(decoded.questionId);
        if (existing) {
          touch(existing).outcome = view.outcome;
          existing.items = view.items;
          existing.summary = view.summary;
        } else {
          const message: QuestionMessage = {
            kind: "question",
            id: event.eventId,
            questionId: decoded.questionId,
            runId: decoded.runId,
            outcome: view.outcome,
            items: view.items,
            summary: view.summary,
          };
          questionMsgById.set(decoded.questionId, message);
          messages.push(message);
        }
        break;
      }
      default:
        break;
    }
  };
  return { messages, dirty, apply };
}

/**
 * Coalesces the raw event log into a transcript in arrival order (one-shot). The incremental live path
 * folds through the same {@link createTranscriptFold} via {@link TranscriptProjector}; this wrapper folds
 * every event then filters the follow-up-queue / superseded prompts, so the output matches the durable-
 * queue projection. `selfProducerId` excludes the host's own echoes from that queue view.
 */
export function toTranscript(
  events: readonly SessionEvent[],
  options: { readonly selfProducerId?: string } = {},
): Message[] {
  const fold = createTranscriptFold();
  for (const event of events) {
    fold.apply(event);
  }
  const hidden = queuedOrSupersededUserIds(events, options.selfProducerId);
  return fold.messages.filter((m) => !(m.kind === "user" && hidden.has(m.id)));
}

/** A shallow copy for structural sharing: every message mutates only top-level fields EXCEPT the
 *  inline-agent block, whose `agents` entries advance in place - so that one array (and its entries) is
 *  copied too. Everything else replaces nested objects (usage/breakdown/stop/artifacts) wholesale. */
function cloneMessage(message: Message): Message {
  if (message.kind === "inlineAgent") {
    return { ...message, agents: message.agents.map((agent) => ({ ...agent })) };
  }
  return { ...message };
}

/** The event types that can change the follow-up queue / active-run / superseded projection. Streaming
 *  deltas (the overwhelming majority of tail events) are NOT here, so the projector's O(scan) queue
 *  recompute is skipped on every token - the whole point of centralizing it. `handoff.accepted` rides so
 *  {@link queuedPromptsFrom}'s initial-handoff suppression stays correct. */
const QUEUE_RELEVANT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user.message",
  "user.supersede",
  "user.command",
  "assistant.started",
  "assistant.completed",
  "handoff.accepted",
]);

function isQueueRelevant(event: SessionEvent): boolean {
  const decoded = decodeTrevorEvent(event);
  return decoded != null && QUEUE_RELEVANT_EVENT_TYPES.has(decoded.type);
}

/** The projector's per-render output: the transcript with structurally-shared row identity, plus the
 *  queue/active-run state centralized out of the per-token re-scans (Tier 0.2). */
export interface TranscriptProjection {
  readonly transcript: Message[];
  readonly activeRunId: string | null;
  readonly awaitingResponse: boolean;
  /** The still-queued follow-ups behind the active turn, projected once per queue change (not per token),
   *  for the send-queue panel to consume without re-scanning the whole log. */
  readonly queued: QueuedPrompt[];
}

/**
 * The incremental transcript projector (Tier 0, the keystone). The eager {@link createSessionReadModel}
 * rebuilt the whole transcript + queue folds on every appended event, so a streaming turn re-ran an
 * O(n) fold per token - O(n^2) per turn - and handed React a brand-new object for every row each token,
 * defeating any row-level memo. This holds the fold state across renders and:
 *   - folds ONLY events past the last-seen seq (O(1) per streaming token), and
 *   - re-clones ONLY the rows a batch actually mutated, so unchanged rows keep object identity and the
 *     Tier 1 `React.memo` boundaries can skip them, while the streaming row still updates.
 * The queue/active-run/superseded projection is recomputed only when a queue-relevant event arrives, so
 * ordinary tokens never pay for it. One projector is bound per session (reset on session switch); the
 * one-shot {@link toTranscript} stays the path for non-live surfaces (agent detail, tangent seed, tests).
 */
export class TranscriptProjector {
  readonly #selfProducerId: string | undefined;
  readonly #fold = createTranscriptFold();
  #lastSeq = Number.NEGATIVE_INFINITY;
  /** internal working message -> the object last handed to React, reused until the message is touched. */
  #emitted = new Map<Message, Message>();
  /** The queue-relevant slice of the log, folded lazily by the durable-queue selectors below. */
  readonly #relevant: SessionEvent[] = [];
  #relevantDirty = true;
  #activeRunId: string | null = null;
  #queued: QueuedPrompt[] = [];
  #hiddenUserIds: Set<string> = new Set();

  constructor(options: { readonly selfProducerId?: string } = {}) {
    this.#selfProducerId = options.selfProducerId;
  }

  /** Folds every event past the last-seen seq. Idempotent: a re-render that passes the same (or a
   *  prefix-stable) event array folds nothing new, so calling it in render is safe. */
  applyAll(events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (event.seq <= this.#lastSeq) {
        continue;
      }
      this.#lastSeq = event.seq;
      this.#fold.apply(event);
      if (isQueueRelevant(event)) {
        this.#relevant.push(event);
        this.#relevantDirty = true;
      }
    }
  }

  /** Materializes the current projection: a fresh array whose entries share identity with the previous
   *  projection except for the rows mutated since it, plus the queue/active state. */
  project(): TranscriptProjection {
    if (this.#relevantDirty) {
      this.#activeRunId = activeTurnRunId(this.#relevant);
      this.#queued = queuedPromptsFrom(this.#relevant, this.#selfProducerId);
      this.#hiddenUserIds = queuedOrSupersededUserIds(this.#relevant, this.#selfProducerId);
      this.#relevantDirty = false;
    }
    const transcript = this.#materialize();
    return {
      transcript,
      activeRunId: this.#activeRunId,
      awaitingResponse: transcript.at(-1)?.kind === "user",
      queued: this.#queued,
    };
  }

  #materialize(): Message[] {
    const { messages, dirty } = this.#fold;
    const hidden = this.#hiddenUserIds;
    const out: Message[] = [];
    const nextEmitted = new Map<Message, Message>();
    for (const message of messages) {
      if (message.kind === "user" && hidden.has(message.id)) {
        continue;
      }
      const previous = this.#emitted.get(message);
      const emitted = previous && !dirty.has(message) ? previous : cloneMessage(message);
      nextEmitted.set(message, emitted);
      out.push(emitted);
    }
    this.#emitted = nextEmitted;
    dirty.clear();
    return out;
  }
}

/**
 * The SidePanel's whole view-model, folded from the transcript (+ the raw events for the
 * live snapshot) in one place - the single surface that owns the live-vs-completed
 * precedence and the per-category context aggregation. Previously four sibling useMemos
 * in app.tsx fanned out as six props; this collapses them so the panel reads from one
 * object and the context sum can never re-list (and so drift from) the canonical category
 * set - it folds every completed request's breakdown via `addBreakdown`.
 *
 * Request data (ctx meter + Request treemap): the in-flight call wins while a turn
 * streams (live usage/breakdown), else the latest completed call's authoritative data.
 * Context data: the whole session - every completed request's breakdown + tokens summed,
 * so it grows turn over turn. `contextBreakdown`/`contextTokens` stay independently
 * undefined (one can be present without the other) to match the prior behavior.
 */
export interface PanelModel {
  readonly ctxUsed?: number;
  readonly ctxMax?: number;
  readonly totalTokens?: number;
  readonly breakdown?: UsageBreakdown;
  readonly contextBreakdown?: UsageBreakdown;
  readonly contextTokens?: number;
}

export interface PanelModelOptions {
  readonly replayed: boolean;
}

export function panelModel(
  transcript: readonly Message[],
  events: readonly SessionEvent[],
  options: PanelModelOptions,
): PanelModel {
  if (!options.replayed) {
    return {};
  }

  // The latest completed call's usage + breakdown (walk back to the newest assistant
  // segment that carries either), for the Request tab / ctx meter when no turn streams.
  let lastCall: AssistantMessage | null = null;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const m = transcript[i];
    if (m?.kind === "assistant" && (m.breakdown || m.usage)) {
      lastCall = m;
      break;
    }
  }

  // The whole-context aggregation: sum every completed request's breakdown (category-
  // driven, via addBreakdown) and its tokens. The two stay independently optional.
  let contextBreakdown: UsageBreakdown | undefined;
  let contextTokens: number | undefined;
  for (const m of transcript) {
    if (m.kind !== "assistant") {
      continue;
    }
    if (m.breakdown) {
      contextBreakdown = contextBreakdown
        ? addBreakdown(contextBreakdown, m.breakdown)
        : m.breakdown;
    }
    if (m.usage) {
      const inputTokens = displayInputTokens(m.usage, m.breakdown) ?? m.usage.input;
      contextTokens = (contextTokens ?? 0) + inputTokens + m.usage.output;
    }
  }

  // A fold that's the most recent context event (no turn has measured the compacted prompt yet, and
  // nothing is streaming): the NEXT prompt will be its `tokensAfter` estimate, not the last request.
  // The ctx meter previews that estimate so it drops the instant a fold lands - the visible proof
  // that compaction shrank the context - and the next real turn replaces it with a measurement. Only
  // the meter previews; the Request treemap stays the last actual request (no faked per-category
  // split, which the provider only reports on a real request).
  // Walk back to the newest fold-or-turn: if a fold is more recent than any completed turn, the next
  // prompt will be its tokensAfter. A short tail walk, not a full forward decode of the whole log.
  let foldAfter: number | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const decoded = event ? decodeTrevorEvent(event) : null;
    if (decoded?.type === "context.compacted") {
      foldAfter = decoded.tokensAfter;
      break;
    }
    if (decoded?.type === "assistant.completed") {
      break; // a completed turn measured the post-fold prompt; no preview needed
    }
  }

  // The in-flight call wins for Request data while a turn streams; else the completed call.
  const live = liveCallFrom(events);
  const previewFold = !live && foldAfter !== undefined;
  const liveInput = displayInputTokens(live?.usage, live?.breakdown);
  const lastInput = displayInputTokens(lastCall?.usage, lastCall?.breakdown);
  const ctxUsed = previewFold ? foldAfter : (liveInput ?? lastInput);
  const ctxMax = live?.usage.contextWindow ?? lastCall?.usage?.contextWindow;
  const totalTokens = live
    ? (liveInput ?? live.usage.input) + live.usage.output
    : lastCall?.usage
      ? (lastInput ?? lastCall.usage.input) + lastCall.usage.output
      : undefined;
  const breakdown = live?.breakdown ?? lastCall?.breakdown;

  // Fold the in-flight turn into the Session totals too, so Session updates live as the current turn
  // streams instead of only after it completes. The open transcript message carries no breakdown until
  // it finishes (the loop above counts only completed turns), but the live snapshot does. On completion
  // the message carries it and `live` is null, so the turn is counted exactly once - no double count.
  if (live?.breakdown) {
    contextBreakdown = contextBreakdown
      ? addBreakdown(contextBreakdown, live.breakdown)
      : live.breakdown;
  }
  if (live?.usage) {
    contextTokens = (contextTokens ?? 0) + (liveInput ?? live.usage.input) + live.usage.output;
  }

  return { ctxUsed, ctxMax, totalTokens, breakdown, contextBreakdown, contextTokens };
}
