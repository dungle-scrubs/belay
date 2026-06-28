import type { UsageBreakdown } from "./breakdown";
import type { InternetSnapshot } from "./connectivity";
import type { CatalogEntry, ModelRef, SourceSignInState, SourceSummary } from "./model-source";
import type { DecodedEvent } from "./protocol-decode";
import type { ProviderQuestionAnswer, ProviderQuestionContract } from "./provider-question";

export type { UsageBreakdown };

/**
 * The trevor session protocol: the `user.message`, `assistant.*`, `tool.*`, and
 * `host.*` events that ride on Richter's generic event log. Richter (wire.ts)
 * owns only the envelope - `type` is a free string and `payload` an arbitrary
 * object - so the trevor-specific event names and payload shapes live HERE, once,
 * shared by both emitters (host + web) and consumers.
 *
 * Two sides:
 *   - `events.*` constructors build `{ type, payload }` for publishing, so the
 *     emit side never spells an event name or payload key by hand.
 *   - `decodeTrevorEvent` folds a raw SessionEvent into a typed, discriminated
 *     `DecodedEvent`, coercing payload fields permissively (a malformed or
 *     forward-compat event yields defaults or `null`, never a throw). Consumers
 *     switch on `.type` instead of hand-guarding `typeof payload.x === "string"`.
 */

/**
 * Token usage for one model step / turn: prompt (context used) + generated, vs the
 * window. Carried on assistant.completed; the host also uses it per model step (D-005).
 */
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly contextWindow: number;
  /** Generation wall-time (first token -> end), ms; for tokens/sec. */
  readonly genMs: number;
}

/** The provider boundary phase that produced a provider incident. */
export type ProviderPhase = "model-step" | "stream" | "tool-protocol" | (string & {});

/** A typed provider incident reason. Unknown future reasons stay renderable. */
export type ProviderIncidentReason =
  | "transport_loss"
  | "auth"
  | "rate_limited"
  | "provider_overloaded"
  | "provider_unavailable"
  | "local_runtime_unavailable"
  | "model_unavailable"
  | "quota_billing"
  | "request_rejected"
  | "context_overflow"
  | "protocol_anomaly"
  | "unknown";

/** Bounded streamed-output counters used to decide whether retry is side-effect safe. */
export interface ProviderPartialCounts {
  readonly textChars: number;
  readonly thinkingChars: number;
  readonly toolCalls: number;
  readonly toolResults: number;
}

/**
 * Structured provider incident data attached to lifecycle events. It is intentionally provider
 * neutral: provider-specific prose is sanitized at the boundary, while the loop and web consume the
 * typed reason, phase, retry verdict, and partial-output counters.
 */
export interface ProviderDiagnostic {
  readonly provider: string;
  readonly model?: string;
  readonly phase: ProviderPhase;
  readonly reason: ProviderIncidentReason;
  readonly retryable: boolean;
  readonly safeToRetry: boolean;
  readonly attempt: number;
  readonly detail: string;
  readonly partials: ProviderPartialCounts;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
}

/** A typed reason for why a turn stopped. Unknown future causes stay renderable. */
export type KnownTurnStopCause =
  | "answered"
  | "context_pressure"
  | "step_backstop"
  | "loop_stalled"
  | "provider_protocol_anomaly"
  | "overflow"
  | "no_reply"
  | "cancelled"
  | "interrupted"
  | "error";

export type TurnStopCause = KnownTurnStopCause | (string & {});

export const TURN_STOP_CAUSE_DESCRIPTIONS = {
  /** The model produced an ordinary final answer. */
  answered: "The model produced an ordinary final answer.",
  /** The prompt is close enough to the context window that the host synthesized before more tools. */
  context_pressure: "The prompt approached the context window.",
  /** The high runaway circuit breaker fired before context pressure. */
  step_backstop: "The high step circuit breaker fired.",
  /** The host saw repeated tool cycles without enough progress. */
  loop_stalled: "The tool loop repeated without enough progress.",
  /** The provider boundary reported malformed or protocol-leaking output. */
  provider_protocol_anomaly: "The provider boundary reported malformed output.",
  /** Context overflow recovery exhausted its cheap rungs. */
  overflow: "Context overflow recovery was exhausted.",
  /** The provider ended without assistant content. */
  no_reply: "The provider ended with no assistant reply.",
  /** The user or host cancelled the run. */
  cancelled: "The run was cancelled.",
  /** The host runtime interrupted or reaped the run. */
  interrupted: "The host interrupted the run.",
  /** A generic terminal host, provider, or tool error stopped the run. */
  error: "A terminal error stopped the run.",
} as const satisfies Record<KnownTurnStopCause, string>;

/** What the host did after selecting a stop cause. */
export type TurnStopAction = "completed" | "synthesized" | "paused" | "recovering" | "failed";

/** Durable stop metadata for assistant.completed. Keep summaries bounded and prompt-safe. */
export interface TurnStop {
  readonly cause: TurnStopCause;
  readonly action: TurnStopAction;
  readonly summary: string;
  readonly steps?: number;
  readonly context?: {
    readonly inputTokens: number;
    readonly contextWindow: number;
    readonly pressure: number;
  };
  readonly diagnosticRef?: string | null;
}

// The wire `UsageBreakdown` type and its category schema live in ./breakdown (the
// single source host accumulation, this decoder, and the web treemap all derive from);
// re-exported above so existing `@trevor/session` importers are unaffected.

/** A selectable provider's display label, model id, and thinking options. */
export interface ProviderModel {
  readonly label: string;
  readonly model: string;
  readonly reasoningLevels: readonly string[];
  readonly defaultReasoning: string;
  /** Where the model runs: "local" (on this machine, e.g. LM Studio) or "cloud". */
  readonly kind: "local" | "cloud";
}

/**
 * An immediate host command (slash command), announced in host.online so the
 * browser knows which `/x` strings route to the host's command lane (executed
 * directly, bypassing the model) and can drive a slash menu. `usage` shows the
 * argument form when there is one (e.g. "/shell <command>").
 */
export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
}

/**
 * A discovered subagent (D-045…D-049), announced in host.online so the model can pick one to
 * delegate to by `description`. `tools`/`skills` are the resolved allow-lists (what the agent may
 * execute / see); the system prompt body stays host-side and never rides the wire.
 */
export interface AgentSpec {
  readonly id: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
}

/**
 * A structured git read model for the host's effective cwd, announced on host.online
 * (D-088). `branch` is the current branch name, or null when detached / a fresh repo;
 * `detached` carries the short commit label when HEAD is detached. `dirty` is any
 * porcelain output (untracked included). `ahead`/`behind` are counted only against a
 * configured `upstream`; both stay 0 when none exists. `worktree` marks a linked git
 * worktree (vs the main work tree). Absent entirely when cwd is not a git repository.
 */
export interface GitStatus {
  readonly branch: string | null;
  readonly detached: string | null;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly upstream: boolean;
  readonly worktree: boolean;
}

/**
 * A Trevor-managed worktree as the host announces it (D-091), so the browser's worktree switcher
 * renders without reading local state. `baseRepo` is the canonical repo identity (grouping key);
 * `baseRepoName` its display name. `baseline` marks the base-repo checkout row (not a managed
 * worktree); `current` the host's active worktree; `missing` a stale entry whose path is gone.
 */
export interface WorktreeSummary {
  readonly id: string;
  readonly baseRepo: string;
  readonly baseRepoName: string;
  readonly branch: string;
  readonly path: string;
  readonly sessionId: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly conflict: boolean;
  readonly detached: boolean;
  readonly current: boolean;
  readonly baseline: boolean;
  readonly missing: boolean;
}

/**
 * A content-addressed artifact (image / document / other file) attached to a
 * message. The bytes do NOT ride the event - they live in the blob store beside
 * Richter (D-028); the event carries only this reference. `hash` is the sha256 the
 * bytes are stored under, so the same artifact is shared across every session and
 * fork that references it. See `blob.ts` for the store client.
 */
export interface ArtifactRef {
  readonly kind: "image" | "document" | "file";
  readonly mimeType: string;
  readonly size: number;
  readonly hash: string;
  readonly name?: string;
}

/** A task's lifecycle state (the V1 set). "deleted" is an update verb, not a state. */
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

/** One task as it rides the wire / renders in the UI (a row of the live checklist). */
export interface TaskSnapshot {
  readonly id: string;
  readonly subject: string;
  readonly activeForm: string;
  readonly status: TaskStatus;
  readonly blockedBy: readonly string[];
  readonly blocks: readonly string[];
}

/**
 * The per-fold DELTA manifest carried on a `context.compacted` event: what THIS fold
 * folded away, not a cumulative picture. `turnRange` is the seq span it covers; `files`,
 * `tools`, and `topics` name the recallable references it collapsed (session recall, D-044,
 * advertises these so the model knows what detail it can ask back). Reconstruct the full
 * folded picture by walking the rolling chain - each fold `supersedes` the prior.
 */
export interface CompactionManifest {
  readonly turnRange: { readonly fromSeq: number; readonly toSeq: number };
  readonly files: readonly string[];
  readonly tools: readonly string[];
  readonly topics: readonly string[];
}

/** A publishable event before a producerId is attached: `{ type, payload }`. */
export interface TrevorEventInput {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

// --- emit side: typed constructors (single source of names + payload shapes) ---

/**
 * Constructors for every trevor event. Each returns `{ type, payload }`; the
 * caller attaches its own producerId at publish time (host vs web). Optional
 * fields (usage/error/reasoning) are omitted when absent so the wire matches the
 * hand-built payloads these replaced.
 */
export const events = {
  userMessage: (p: {
    text: string;
    provider: string;
    reasoning?: string;
    /** The selected model reference (D-065 migration). Carried ALONGSIDE the legacy `provider`/
     *  `reasoning` so old consumers keep working; the host prefers it via resolveUserTurnModel. */
    model?: ModelRef;
    artifacts?: readonly ArtifactRef[];
  }): TrevorEventInput => ({
    type: "user.message",
    payload: {
      text: p.text,
      provider: p.provider,
      ...(p.reasoning ? { reasoning: p.reasoning } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.artifacts?.length ? { artifacts: p.artifacts } : {}),
    },
  }),
  assistantStarted: (p: {
    runId: string;
    warm: boolean;
    model: string;
    provider: string;
  }): TrevorEventInput => ({
    type: "assistant.started",
    payload: { runId: p.runId, warm: p.warm, model: p.model, provider: p.provider },
  }),
  assistantDelta: (p: { runId: string; text: string }): TrevorEventInput => ({
    type: "assistant.delta",
    payload: { runId: p.runId, text: p.text },
  }),
  assistantThinking: (p: { runId: string; text: string }): TrevorEventInput => ({
    type: "assistant.thinking",
    payload: { runId: p.runId, text: p.text },
  }),
  assistantOverflow: (p: { runId: string; reason: string }): TrevorEventInput => ({
    type: "assistant.overflow",
    payload: { runId: p.runId, reason: p.reason },
  }),
  /** A graceful-overflow-recovery adjustment: the loop trimmed/reduced and is retrying.
   *  The within-turn airbag - distinct from `context.compacted`, the durable cross-turn fold. */
  assistantRecovered: (p: {
    runId: string;
    action: "trim" | "reduce-thinking";
    detail: string;
    reclaimed: number;
  }): TrevorEventInput => ({
    type: "assistant.recovered",
    payload: { runId: p.runId, action: p.action, detail: p.detail, reclaimed: p.reclaimed },
  }),
  /** A transient provider outage is being auto-retried before any token streamed (D-076…D-079):
   *  the loop reconnected the dropped stream and is re-running the current step. `attempt` is the
   *  1-based retry number. Sibling to `assistant.recovered`, applied to transport faults. */
  assistantReconnecting: (p: {
    runId: string;
    attempt: number;
    detail: string;
    diagnostic?: ProviderDiagnostic;
  }): TrevorEventInput => ({
    type: "assistant.reconnecting",
    payload: {
      runId: p.runId,
      attempt: p.attempt,
      detail: p.detail,
      ...(p.diagnostic ? { diagnostic: p.diagnostic } : {}),
    },
  }),
  /**
   * A subagent delegation (D-046): this event on the PARENT session links the parent turn (`runId`)
   * to the isolated child session (`childSessionId`) a delegation spawned, naming the `agent` and
   * the `task` it was given. Analogous to a fork link - the child is its own session with its own
   * log; this is the only thread connecting them. `status` tracks the child's lifecycle for the UI
   * ("running" while it works; "done"/"failed" when it folds back). `result` carries the child's
   * distilled final message once it finishes (the frozen result a later parent-fork reuses).
   */
  delegatedTo: (p: {
    runId: string;
    childSessionId: string;
    agent: string;
    task: string;
    mode: "inline" | "background";
    status: "running" | "done" | "failed";
    result?: string;
  }): TrevorEventInput => ({
    type: "delegated.to",
    payload: {
      runId: p.runId,
      childSessionId: p.childSessionId,
      agent: p.agent,
      task: p.task,
      mode: p.mode,
      status: p.status,
      ...(p.result !== undefined ? { result: p.result } : {}),
    },
  }),
  /**
   * A durable cross-turn compaction fold (D-040…D-043): the rolling summary that keeps the
   * prompt projection under the window. Appended, never mutating the log; each fold supersedes
   * the prior (the rolling chain), so the prompt-builder takes the latest. The manifest is this
   * fold's delta. Distinct from `assistant.recovered`, the within-turn airbag.
   */
  contextCompacted: (p: {
    foldId: string;
    throughSeq: number;
    supersedes?: string;
    summary: string;
    manifest: CompactionManifest;
    tokensBefore: number;
    tokensAfter: number;
    model: string;
  }): TrevorEventInput => ({
    type: "context.compacted",
    payload: {
      foldId: p.foldId,
      throughSeq: p.throughSeq,
      ...(p.supersedes ? { supersedes: p.supersedes } : {}),
      summary: p.summary,
      manifest: p.manifest,
      tokensBefore: p.tokensBefore,
      tokensAfter: p.tokensAfter,
      model: p.model,
    },
  }),
  /**
   * A live, advisory progress tick while a fold's summary is being generated (D-040): the rolling
   * summary streams, so the UI fills a transient progress bar from `tokens` against `budget`. The
   * matching `context.compacted` ends the fold and the bar vanishes. Like `assistant.progress`,
   * this is advisory (need not be replay-perfect) - honest per tick (real tokens streamed so far),
   * never a predicted percentage.
   */
  contextCompacting: (p: { foldId: string; tokens: number; budget: number }): TrevorEventInput => ({
    type: "context.compacting",
    payload: { foldId: p.foldId, tokens: p.tokens, budget: p.budget },
  }),
  /**
   * A live, mid-turn usage snapshot. Each model step reports its prompt size, so
   * the UI's context meter can grow as the turn runs instead of jumping only at
   * completion. The terminal assistant.completed still carries the authoritative
   * final usage + breakdown; these are advisory and need not be persisted-perfect.
   */
  assistantProgress: (p: {
    runId: string;
    usage: Usage;
    breakdown?: UsageBreakdown;
  }): TrevorEventInput => ({
    type: "assistant.progress",
    payload: {
      runId: p.runId,
      usage: p.usage,
      ...(p.breakdown ? { breakdown: p.breakdown } : {}),
    },
  }),
  assistantCompleted: (p: {
    runId: string;
    text: string;
    usage?: Usage;
    breakdown?: UsageBreakdown;
    error?: string;
    cancelled?: boolean;
    interrupted?: boolean;
    noReply?: boolean;
    stepLimit?: number;
    stop?: TurnStop;
    diagnostic?: ProviderDiagnostic;
  }): TrevorEventInput => ({
    type: "assistant.completed",
    payload: {
      runId: p.runId,
      text: p.text,
      ...(p.usage ? { usage: p.usage } : {}),
      ...(p.breakdown ? { breakdown: p.breakdown } : {}),
      ...(p.error ? { error: p.error } : {}),
      ...(p.cancelled ? { cancelled: true } : {}),
      // Closed by the host (restart/crash mid-turn reap), not by the user - rendered distinctly
      // from `cancelled` so a host hot-reload never looks like the user pressed ESC.
      ...(p.interrupted ? { interrupted: true } : {}),
      ...(p.noReply ? { noReply: true } : {}),
      // Step count when the turn was budget-terminated (step backstop or context gate);
      // omitted on a normal turn. A forced final answer still streams; this flags WHY.
      ...(p.stepLimit ? { stepLimit: p.stepLimit } : {}),
      ...(p.stop ? { stop: p.stop } : {}),
      ...(p.diagnostic ? { diagnostic: p.diagnostic } : {}),
    },
  }),
  /** User asked to cancel the active run (hard steering / ESC). */
  userCancel: (p: { runId: string }): TrevorEventInput => ({
    type: "user.cancel",
    payload: { runId: p.runId },
  }),
  /** Browser invokes an immediate host command, bypassing the model/turn queue. */
  userCommand: (p: { command: string; args: string }): TrevorEventInput => ({
    type: "user.command",
    payload: { command: p.command, args: p.args },
  }),
  /** Host's immediate result for a user.command (rendered, never fed to the model). */
  commandResult: (p: { command: string; text: string; ok: boolean }): TrevorEventInput => ({
    type: "command.result",
    payload: { command: p.command, text: p.text, ok: p.ok },
  }),
  /**
   * Host-authored session handoff. Used by /clear to move the browser into a newly minted durable
   * session after the leader has ensured it and spawned an attached replacement host.
   */
  sessionSwitch: (p: {
    sessionId: string;
    reason: "clear" | "cd" | "resume" | "worktree";
  }): TrevorEventInput => ({
    type: "session.switch",
    payload: { sessionId: p.sessionId, reason: p.reason },
  }),
  /**
   * The durable archive flag for a session (D-094): archive hides a session from the main UI,
   * sidebar, and default resume/inventory views without deleting its log; unarchive clears it. The
   * LATEST `session.archived` event wins, so it doubles as an unarchive (`archived: false`). It is a
   * lifecycle marker, not transcript content.
   */
  sessionArchived: (p: { archived: boolean }): TrevorEventInput => ({
    type: "session.archived",
    payload: { archived: p.archived },
  }),
  /**
   * A durable, user-set session TITLE (editable session names): overrides the first-prompt-derived
   * title in the inventory. The LATEST `session.title` wins (latest rename), and an empty title falls
   * back to the derived one. A lifecycle marker, not transcript content - kept out of prompt history.
   */
  sessionTitle: (p: { title: string }): TrevorEventInput => ({
    type: "session.title",
    payload: { title: p.title },
  }),
  /**
   * A durable SOFT-DELETE flag for a session (sidebar Delete): hides it from every view (sidebar,
   * /resume, inventory) more permanently than archive, without purging the durable log (a hard purge
   * is a future store operation). The LATEST `session.deleted` wins, so `deleted: false` is an undo. A
   * lifecycle marker, kept out of prompt history.
   */
  sessionDeleted: (p: { deleted: boolean }): TrevorEventInput => ({
    type: "session.deleted",
    payload: { deleted: p.deleted },
  }),
  /**
   * The prompt shell lane (D-082): a leading `!` in the composer runs a shell command immediately
   * through the live leader's protected `runShell` path, bypassing the model and the turn queue.
   * `requestId` pairs this with its `shell.result`. The output is user-visible only - it is NOT
   * fed back into the model context for this cut (history projection ignores both events).
   */
  userShell: (p: { requestId: string; command: string }): TrevorEventInput => ({
    type: "user.shell",
    payload: { requestId: p.requestId, command: p.command },
  }),
  /** The leader's result for a user.shell (rendered as a terminal block, never fed to the model).
   *  `ok` is false for a refused (safety floor) or non-zero / timed-out command; `output` is the
   *  capped command output (or the refusal/failure text). */
  shellResult: (p: {
    requestId: string;
    command: string;
    output: string;
    ok: boolean;
  }): TrevorEventInput => ({
    type: "shell.result",
    payload: { requestId: p.requestId, command: p.command, output: p.output, ok: p.ok },
  }),
  /**
   * Browser asks the host to open a file in the local editor. A side-channel
   * action - not part of the conversation, so it never renders in the transcript
   * nor reaches the model. The host runs its configured editor CLI.
   */
  editorOpen: (p: { path: string; line?: number; column?: number }): TrevorEventInput => ({
    type: "editor.open",
    payload: {
      path: p.path,
      ...(p.line != null ? { line: p.line } : {}),
      ...(p.column != null ? { column: p.column } : {}),
    },
  }),
  /** The whole task checklist after a change - a snapshot the UI renders and the host restores from. */
  tasksCurrent: (p: { tasks: readonly TaskSnapshot[] }): TrevorEventInput => ({
    type: "tasks.current",
    payload: { tasks: p.tasks },
  }),
  toolStarted: (p: {
    runId: string;
    callId: string;
    name: string;
    arguments: string;
  }): TrevorEventInput => ({
    type: "tool.started",
    payload: { runId: p.runId, callId: p.callId, name: p.name, arguments: p.arguments },
  }),
  toolCompleted: (p: {
    runId: string;
    callId: string;
    name: string;
    result: string;
  }): TrevorEventInput => ({
    type: "tool.completed",
    payload: { runId: p.runId, callId: p.callId, name: p.name, result: p.result },
  }),
  hostBeat: (p: { instanceId: string }): TrevorEventInput => ({
    type: "host.beat",
    payload: { instanceId: p.instanceId },
  }),
  hostHello: (p: { instanceId: string }): TrevorEventInput => ({
    type: "host.hello",
    payload: { instanceId: p.instanceId },
  }),
  hostRole: (p: { instanceId: string; role: string }): TrevorEventInput => ({
    type: "host.role",
    payload: { instanceId: p.instanceId, role: p.role },
  }),
  /**
   * The host's public-internet reachability snapshot (D-060): emitted on a `checking` start, a
   * status change, and a refresh completion. Advisory only - it drives no routing and is kept OUT of
   * conversation memory / prompt-history projection (a presence-style signal, like host.beat).
   */
  hostInternet: (p: { snapshot: InternetSnapshot }): TrevorEventInput => ({
    type: "host.internet",
    payload: { internet: p.snapshot },
  }),
  /**
   * A host-driven source sign-in flow's state (D-065 M5): emitted as the host runs an OAuth/device-code
   * login - the `device-code` phase carries the verification URL + short user code, then `complete`
   * (the catalog re-announce flips the source to ready) or `error`. Advisory/presence-style, kept OUT
   * of conversation memory (like host.internet); carries a verification code, never an API key.
   */
  hostSourceAuth: (p: { state: SourceSignInState }): TrevorEventInput => ({
    type: "host.sourceAuth",
    payload: { ...p.state },
  }),
  hostOnline: (p: {
    branch?: string;
    git?: GitStatus;
    providers: readonly string[];
    default: string;
    models: Record<string, ProviderModel>;
    instanceId: string;
    cwd: string;
    workspace: string;
    commands: readonly CommandSpec[];
    agents: readonly AgentSpec[];
    worktrees?: readonly WorktreeSummary[];
    /** The latest internet snapshot, so a joining client sees connectivity without waiting. */
    internet?: InternetSnapshot;
    /** The host-owned model SOURCES (D-065): provider/runtime/subscription summaries with auth state. */
    sources?: readonly SourceSummary[];
    /** The per-source model catalog (D-065), keyed by sourceId. */
    catalog?: Readonly<Record<string, readonly CatalogEntry[]>>;
  }): TrevorEventInput => ({
    type: "host.online",
    payload: {
      ...(p.branch ? { branch: p.branch } : {}),
      ...(p.git ? { git: p.git } : {}),
      providers: p.providers,
      default: p.default,
      models: p.models,
      instanceId: p.instanceId,
      cwd: p.cwd,
      workspace: p.workspace,
      commands: p.commands,
      agents: p.agents,
      ...(p.worktrees ? { worktrees: p.worktrees } : {}),
      ...(p.internet ? { internet: p.internet } : {}),
      ...(p.sources ? { sources: p.sources } : {}),
      ...(p.catalog ? { catalog: p.catalog } : {}),
    },
  }),
  /**
   * A model-asked user question (ask_user): the host emits this when the tool blocks the active tool
   * call, carrying the run + tool-call it belongs to, the originating `adapter`/`toolName`, and the
   * normalized question `contract`. The browser renders it and publishes `provider.question.answer`; the
   * host injects that answer as the tool result and closes it with `provider.question.resolved`.
   */
  providerQuestionRequested: (p: {
    questionId: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    adapter: string;
    contract: ProviderQuestionContract;
  }): TrevorEventInput => ({
    type: "provider.question.requested",
    payload: {
      questionId: p.questionId,
      runId: p.runId,
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      adapter: p.adapter,
      contract: p.contract,
    },
  }),
  /** The user's answer to a pending question: an accept with per-question entries, or decline/cancel. */
  providerQuestionAnswer: (p: {
    questionId: string;
    answer: ProviderQuestionAnswer;
  }): TrevorEventInput => ({
    type: "provider.question.answer",
    payload: { questionId: p.questionId, answer: p.answer },
  }),
  /**
   * The host closing a pending question: it injected the answer (or the run ended first) and names the
   * `outcome`. `summary` is a sanitized one-liner for the transcript/diagnostics - never the raw answer body.
   */
  providerQuestionResolved: (p: {
    questionId: string;
    runId: string;
    toolCallId: string;
    outcome: "answered" | "declined" | "cancelled" | "expired";
    summary: string;
  }): TrevorEventInput => ({
    type: "provider.question.resolved",
    payload: {
      questionId: p.questionId,
      runId: p.runId,
      toolCallId: p.toolCallId,
      outcome: p.outcome,
      summary: p.summary,
    },
  }),
  /**
   * Escape hatch for an arbitrary `{ type, payload }`: the same envelope every typed builder
   * above yields, with the type/payload chosen at the call site instead of fixed. Tests use it
   * to emit forward-compat / not-yet-typed events through the production input pipeline rather
   * than hand-spelling the shape; it is NOT a substitute for a typed builder on the emit path.
   */
  raw: (type: string, payload: Record<string, unknown>): TrevorEventInput => ({ type, payload }),
} as const;

/**
 * The lifecycle event types the inventory reads for a session's activity signal (D-032): the
 * starts/completions of model turns plus the immediate user commands. Owned here beside the
 * event constructors so a new lifecycle event is added once - typed as DecodedEvent["type"]
 * so an entry can only ever be a real protocol event name, never a free-typed string.
 */
export const LIFECYCLE_TYPES = [
  "assistant.started",
  "assistant.completed",
  "user.command",
] as const satisfies readonly DecodedEvent["type"][];

export type { DecodedEvent } from "./protocol-decode";
export { decodeTrevorEvent } from "./protocol-decode";
