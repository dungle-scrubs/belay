import {
  type ArtifactRef,
  addBreakdown,
  decodeTrevorEvent,
  inputEstimateTokens,
  type ProviderDiagnostic,
  type ProviderQuestionAnswer,
  type ProviderQuestionContract,
  READ_ONLY_TOOL_NAMES,
  type SessionEvent,
  type TurnStop,
  type Usage,
  type UsageBreakdown,
} from "@trevor/session";
import { type QuestionOutcome, summarizeProviderQuestion } from "./derive";

export type { ArtifactRef, Usage, UsageBreakdown };

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
export type Message =
  | { kind: "user"; id: string; text: string; artifacts: readonly ArtifactRef[] }
  | AssistantMessage
  | ToolMessage
  | CommandResultMessage
  | RecoveredMessage
  | ContinuedMessage
  | ReconnectingMessage
  | CompactingMessage
  | DelegationMessage
  | ShellMessage
  | QuestionMessage;

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
 * Coalesces the raw event log into a transcript in arrival order. An assistant turn
 * is split into segments at each tool call: the open segment is finalized when a tool
 * starts, so thinking/text that comes *after* a tool renders below it (not lumped into
 * one bubble at the top). started only records the run's model/warmth; a segment is
 * created lazily on the first thinking/text, so an empty turn never leaves a stray bubble.
 * Payloads are read through decodeTrevorEvent, so the fold never hand-guards raw fields.
 */
export function toTranscript(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];
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
  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
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
        messages.push({
          kind: "user",
          id: event.eventId,
          text: decoded.text,
          artifacts: decoded.artifacts,
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
          shellByRequest.clear();
          questionContractById.clear();
          questionAnswerById.clear();
          questionMsgById.clear();
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
        });
        break;
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
          existing.done = true;
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
        openSegment(decoded.runId).text += decoded.text;
        break;
      case "assistant.thinking":
        openSegment(decoded.runId).thinking += decoded.text;
        break;
      case "assistant.overflow":
        openSegment(decoded.runId).overflow = decoded.reason;
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
          open.done = true;
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
          open.done = true;
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
      case "assistant.reconnecting": {
        // Finalize any open segment so the reconnected attempt's output starts fresh below the
        // marker (a reconnect fires before any token, so usually nothing is open).
        const open = openByRun.get(decoded.runId);
        if (open) {
          open.done = true;
          openByRun.delete(decoded.runId);
        }
        messages.push({
          kind: "reconnecting",
          id: event.eventId,
          attempt: decoded.attempt,
          ...(decoded.maxAttempts != null ? { maxAttempts: decoded.maxAttempts } : {}),
          detail: decoded.detail,
        });
        break;
      }
      case "delegated.to": {
        // First link for a child spawns the block; later links (done/failed, with the result)
        // advance the same block in place, so the UI shows one linked card per delegation.
        const existing = delegationByChild.get(decoded.childSessionId);
        if (existing) {
          existing.status = decoded.status;
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
          existing.tokens = Math.max(existing.tokens, decoded.tokens);
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
        // Finalize the open segment so the next thinking/text starts a new one below the tool.
        const open = openByRun.get(decoded.runId);
        if (open) {
          open.done = true;
          openByRun.delete(decoded.runId);
        }
        // ask_user renders as the live QuestionSurface (M5), not a transcript tool row: suppress its
        // tool.started/tool.completed so the pending question + its answer never show as a tool block.
        if (decoded.name === "ask_user") {
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
          tool.done = true;
          // A real completion wins over a prior abort (defensive; an interrupted tool emits none).
          tool.aborted = false;
          tool.result = decoded.result;
        }
        break;
      }
      case "assistant.completed": {
        // The run is terminal now: finalize any tool that never got its own completion (a read-only
        // tool still in flight when the user cancelled), so it stops rendering as "running". Marking
        // the run terminated also aborts a `tool.started` that races in after this completion.
        terminatedRuns.add(decoded.runId);
        for (const tool of toolsByRun.get(decoded.runId) ?? []) {
          if (!tool.done) {
            tool.done = true;
            tool.aborted = true;
          }
        }
        toolsByRun.delete(decoded.runId);
        // Land the final state on the run's last segment (or a fresh one if the turn
        // produced nothing visible, so an error still has somewhere to show).
        const segment =
          openByRun.get(decoded.runId) ??
          lastByRun.get(decoded.runId) ??
          openSegment(decoded.runId);
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
          existing.outcome = view.outcome;
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
  }
  return messages;
}

/**
 * The SidePanel's whole view-model, folded from the transcript (+ the raw events for the
 * live snapshot) in one place - the single surface that owns the live-vs-completed
 * precedence and the per-category context aggregation. Previously four sibling useMemos
 * in App.tsx fanned out as six props; this collapses them so the panel reads from one
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
