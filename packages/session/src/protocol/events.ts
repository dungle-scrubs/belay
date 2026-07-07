import type { UsageBreakdown } from "../breakdown";
import type { CommandMenuPayload } from "../command-menu";
import type { InternetSnapshot } from "../connectivity";
import type { FileMatch } from "../file-mention";
import type { LoopSnapshot } from "../loop-command";
import type { LucidArtifactMeta, LucidDeliveredAnnotation, LucidProvenance } from "../lucid";
import type { CatalogEntry, ModelRef, SourceSignInState, SourceSummary } from "../model-source";
import type { PastePayload } from "../paste-tokens";
import type { ProviderQuestionAnswer, ProviderQuestionContract } from "../provider-question";
import type { LimitStatus } from "../usage-limit";
import type { DecodedEvent } from "./decode";

export type { UsageBreakdown };

/**
 * The trevor session protocol: the `user.message`, `assistant.*`, `tool.*`, and
 * `host.*` events that ride on Tether's generic event log. Tether (wire.ts)
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
  | "hook_halt"
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
  /** A configured hook blocked the tool call or the finalization (plan 25). */
  hook_halt: "A hook halted the turn.",
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
  /**
   * The argument form for a file-loaded custom command (plan 44.5), from the command file's
   * `argument-hint` frontmatter, e.g. `<issue-number>`. Drives the web menu's inline hint and the live
   * substitution preview. Absent for built-in commands and for custom commands with no hint declared.
   */
  readonly argumentHint?: string;
  /**
   * The raw body template of a file-loaded custom command (plan 44.5), carrying its `$0`/`$ARGUMENTS`
   * placeholders. Published so the web can render a LIVE substitution preview that matches what the host
   * will submit. Present only for file-loaded commands; built-in commands announce no body.
   */
  readonly body?: string;
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
 * The single owner of the "branch, else `detached <sha>`" ref-label rule. Returns the branch
 * name, the `detached <sha>` label when HEAD is detached, or null when there's no ref to show
 * (a fresh repo with no commit yet). Used by the host (`host.online` branch, /doctor) and the
 * web sidebar so the label can't drift between surfaces.
 */
export function gitRefLabel(status: GitStatus): string | null {
  if (status.branch) {
    return status.branch;
  }
  if (status.detached) {
    return `detached ${status.detached}`;
  }
  return null;
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
 * Tether (D-028); the event carries only this reference. `hash` is the sha256 the
 * bytes are stored under, so the same artifact is shared across every session and
 * fork that references it. See `blob.ts` for the store client.
 */
export interface ArtifactRef {
  readonly kind: "image" | "document" | "file";
  readonly mimeType: string;
  readonly size: number;
  readonly hash: string;
  readonly name?: string;
  /**
   * The LUCID addressability sidecar (plan 27), kept SEPARATE from the content-addressed blob fields
   * above (M1 REFACTOR): its presence marks this HTML artifact as an addressable Lucid surface the
   * panel renders with element/text-range annotation; its absence degrades the artifact to the plain
   * (non-addressable) HTML/document viewer, so generic HTML rendering is never broken. See `lucid.ts`.
   */
  readonly lucid?: LucidArtifactMeta;
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

/** How a tracked background job came to exist (plan 09): a direct `process` start, or a promoted bash /
 *  prompt-shell command. */
export type JobSource = "process" | "bash" | "shell";
export type JobLifecycle = "running" | "exited" | "killed";

/**
 * A promoted background job snapshot (plan 09), announced on `host.online` so the support panel + detail
 * takeover see the host's tracked jobs without a model round-trip. Structurally identical to the host's
 * supervisor snapshot, so the host announces it directly.
 */
export interface JobSnapshot {
  readonly id: string;
  readonly command: string;
  readonly source: JobSource;
  readonly runId?: string;
  readonly callId?: string;
  readonly requestId?: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly promotedAt?: number;
  readonly status: JobLifecycle;
  readonly exitCode: number | null;
  readonly stdoutTotal: number;
  readonly stderrTotal: number;
  /** A bounded tail of the combined output (last few KB), so the detail takeover shows recent output;
   *  it refreshes when the host re-announces (on each job state change). Absent / empty when none yet. */
  readonly tail?: string;
}

/** The revision a `tasks.current` event without freshness metadata decodes to (a legacy/pre-09 log). */
export const LEGACY_TASK_REVISION = 0;

/**
 * Whether an incoming `tasks.current` snapshot should REPLACE the one currently held, given both
 * revisions and that events are processed in log/arrival order. A higher revision always wins; an
 * equal revision (including the legacy 0 that every pre-freshness event shares) counts as the newer
 * arrival and also wins, so the latest event still takes effect; a strictly lower revision is stale
 * and is rejected. The single comparison shared by the host replay/standby load guard and the web
 * `tasksFrom` derivation, so host and web never disagree about which snapshot is current. <!-- D-004 -->
 */
export function taskSnapshotReplaces(incomingRev: number, currentRev: number): boolean {
  return incomingRev >= currentRev;
}

/**
 * Whether a `delegated.to` status is TERMINAL - the child has folded back (`done`), hit a genuine error
 * (`failed`), or was closed by orphan recovery (`interrupted`, a leader died/reaped it - plan 52/D-002).
 * `running` is the only non-terminal status. The single classifier the transcript reducer, the
 * support-panel rows, the browser orphan detector, and the host reap all share, so they cannot disagree
 * on which statuses close a delegation link (a link with no terminal for its `childSessionId` is an
 * orphan the recovery paths reap). The decoded `status` is a permissive string, so this narrows it.
 */
export function isTerminalDelegationStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "interrupted";
}

/** The agent id the workflow engine's leaves delegate under (plan 21). Workflow leaves reuse the same
 *  `delegated.to{mode:"inline"}` link + shared seed/fold-back as a `delegate_inline` tool call, so this
 *  is the one discriminator that tells the two apart. Exported so the host and web agree on it. */
export const WORKFLOW_LEAF_AGENT_ID = "workflow-leaf";

/**
 * Whether a `delegated.to` link is a blocking INLINE-AGENT delegation (plan 09.4) - the surface that
 * renders as a compact inline-agent row, stamps live model/reasoning/token metadata, and drives the
 * "delegating to X…" turn-status headline. TRUE only for `mode:"inline"` links that are NOT a workflow
 * leaf (which shares `mode:"inline"` but has its own workflow rendering and must stay unchanged). The
 * single classifier the host metadata seam, the transcript reducer, and the turn-status projection
 * share, so a workflow leaf can never be mistaken for an inline agent on any surface.
 */
export function isInlineAgentDelegation(mode: string, agent: string): boolean {
  return mode === "inline" && agent !== WORKFLOW_LEAF_AGENT_ID;
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

/** How a continuation handoff produces the target prompt: model-generated, or the supplied text as-is. */
export type HandoffMode = "generate" | "direct";

/**
 * What a tangent fold-back (plan 37, M8) carried back toward the parent: a `quote` of the selected
 * source snapshot, a specific tangent `message`, or a `summary` of the tangent's outcome. Named so the
 * durable fold-back record and the web preview label can never drift on the vocabulary.
 */
export type TangentFoldMode = "quote" | "message" | "summary";

/** A publishable event before a producerId is attached: `{ type, payload }`. */
export interface TrevorEventInput {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** The lifecycle gate a hook decision came from (plan 25 D-002): the two first-cut hook events. */
export type HookDecisionEventName = "PreToolUse" | "Stop";

/**
 * What a `hook.decision` event records (plan 25 M9, D-009): a hook's visible effect on the turn.
 * `deny`/`halt` are the blocking decisions, `context`/`updated_input` the bounded influence
 * verbs, `continuation` a Stop hook's one-pass continuation request, and
 * `timeout`/`error`/`unapproved`/`trust_changed` the diagnostic states. An `allow` is
 * deliberately NOT here: it never rides the wire (one event per tool call would drown the log;
 * the host's structured hook logs keep the audit trail).
 */
export type HookDecisionKind =
  | "deny"
  | "halt"
  | "context"
  | "updated_input"
  | "continuation"
  | "timeout"
  | "error"
  | "unapproved"
  | "trust_changed";

/**
 * Why a queued follow-up was superseded on the durable log (plan 47 D-003), for observability and
 * rendering. `fold` is the first-Escape collapse of N queued prompts into one steering replacement
 * (supersede-with-replacement); `unqueue` drops one queued prompt outright (supersede-no-replacement);
 * `recall` pulls one queued prompt back into the composer to edit (also no replacement, re-enqueued on
 * re-submit). Kept open (`string & {}`) so a forward-compat reason stays renderable.
 */
export type SupersedeReason = "fold" | "unqueue" | "recall" | (string & {});

/** Who asked for a mid-turn model/reasoning switch: `manual` (the UI selector) now, `auto` (the future
 *  auto-router) later. The single seam both initiators attach to (plan 09.1 D-004). */
export type ModelSwitchInitiator = "manual" | "auto";

/** Whether a mid-turn switch took effect or was refused by the larger->smaller context guard (D-007). */
export type ModelSwitchOutcome = "applied" | "blocked";

/** One side of a mid-turn switch - the model id + reasoning level in effect. Rides `model.switched` as
 *  `from`/`to` so the delta renders, including a reasoning-only change (same model on both sides). */
export interface ModelSwitchEndpoint {
  readonly model: string;
  readonly reasoning?: string;
}

/**
 * The outcome the supervisor reports for a `session.launch.requested` (plan 44.1): a host was freshly
 * spawned (`launched`), an already-live host was reused (`reused`), or the launch could not be
 * satisfied (`failed`, carrying an error message). One source for the literal set so the emit
 * constructor, the tolerant decode, and the browser handler cannot drift.
 */
export const SESSION_LAUNCH_STATUSES = ["launched", "reused", "failed"] as const;
export type SessionLaunchStatus = (typeof SESSION_LAUNCH_STATUSES)[number];
/** The non-failure launch outcomes the launcher resolves: a fresh/replaced host (`launched`) or an
 *  already-live one (`reused`). Shared so the launcher runner and the dispatcher can't drift. */
export type SessionLaunchOkStatus = Exclude<SessionLaunchStatus, "failed">;

/** One recent project the supervisor reports in `projects.list.result` (plan 44.1): the canonical
 *  root, its derived session id, and when the launcher last touched the mapping. */
export interface SupervisorProject {
  readonly root: string;
  readonly sessionId: string;
  readonly updatedAt: string;
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
    /** Exact pasted-text payloads paired to the message's `[Pasted text #N +M lines]` tokens, in
     *  reading order (10-large-paste-placeholders). Expanded at the token position for the provider. */
    pastes?: readonly PastePayload[];
  }): TrevorEventInput => ({
    type: "user.message",
    payload: {
      text: p.text,
      provider: p.provider,
      ...(p.reasoning ? { reasoning: p.reasoning } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.artifacts?.length ? { artifacts: p.artifacts } : {}),
      ...(p.pastes?.length ? { pastes: p.pastes } : {}),
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
  /** A step-budget CHECKPOINT auto-continued the turn (02.17): the adaptive step budget was reached
   *  with context headroom + progress below the emergency ceiling, so the loop continued instead of
   *  pausing. A durable, NON-terminating inline breadcrumb (sibling to `assistant.recovered`); the
   *  alarming `step_backstop` pause card renders only on a genuine terminating stop. `steps` is where it
   *  continued, `pressure` the context fraction (0..1), `threshold` the next checkpoint's step bound. */
  assistantContinued: (p: {
    runId: string;
    steps: number;
    pressure: number;
    threshold: number;
    detail: string;
  }): TrevorEventInput => ({
    type: "assistant.continued",
    payload: {
      runId: p.runId,
      steps: p.steps,
      pressure: p.pressure,
      threshold: p.threshold,
      detail: p.detail,
    },
  }),
  /**
   * A mid-turn model/reasoning switch was applied (or refused) at a step boundary (plan 09.1 D-003): the
   * durable record of `from`/`to` model+reasoning, who asked (`initiator`), and the `outcome`. Recorded
   * on the session log so replay reconstructs the active model at every point; the web folds it into the
   * transcript switch marker, including a reasoning-only change (same model on both sides).
   */
  modelSwitched: (p: {
    runId: string;
    from: ModelSwitchEndpoint;
    to: ModelSwitchEndpoint;
    initiator: ModelSwitchInitiator;
    outcome: ModelSwitchOutcome;
    reason?: string;
  }): TrevorEventInput => ({
    type: "model.switched",
    payload: {
      runId: p.runId,
      from: p.from,
      to: p.to,
      initiator: p.initiator,
      outcome: p.outcome,
      ...(p.reason ? { reason: p.reason } : {}),
    },
  }),
  /**
   * A provider usage-limit signal (plan 44.4): the session is `approaching` or has `reached` a provider
   * rate/usage window (Claude's `anthropic-ratelimit-unified-*` headers, a terminal Codex 429). One
   * provider-agnostic payload with a Trevor-native `status`; `resetsAt` (unix epoch SECONDS) and
   * `utilization` (0..1 fraction used) ride only when the provider exposed them, spread-omitted otherwise
   * like `modelSwitched`'s optionals. Detection only (D-004) - the transcript marks it; nothing acts on it.
   */
  assistantLimit: (p: {
    provider: string;
    status: LimitStatus;
    scope: string;
    resetsAt?: number;
    utilization?: number;
  }): TrevorEventInput => ({
    type: "assistant.limit",
    payload: {
      provider: p.provider,
      status: p.status,
      scope: p.scope,
      ...(p.resetsAt != null ? { resetsAt: p.resetsAt } : {}),
      ...(p.utilization != null ? { utilization: p.utilization } : {}),
    },
  }),
  /** A transient provider outage is being auto-retried before any token streamed (D-076…D-079):
   *  the loop reconnected the dropped stream and is re-running the current step. `attempt` is the
   *  1-based retry number. Sibling to `assistant.recovered`, applied to transport faults. */
  assistantReconnecting: (p: {
    runId: string;
    attempt: number;
    /** Total attempt budget (initial + retries), so the UI shows a true `attempt/maxAttempts`.
     *  Optional for backward-compatible replay of logs written before it was threaded. */
    maxAttempts?: number;
    detail: string;
    diagnostic?: ProviderDiagnostic;
  }): TrevorEventInput => ({
    type: "assistant.reconnecting",
    payload: {
      runId: p.runId,
      attempt: p.attempt,
      ...(p.maxAttempts != null ? { maxAttempts: p.maxAttempts } : {}),
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
    model?: string;
    // `interrupted` (plan 52 / D-002): a child closed by orphan recovery - a leader died or reaped it
    // mid-delegation - kept distinct from `failed` (a genuine task error) so the UI renders a muted
    // "interrupted" note, not an error. Terminal like done/failed (see isTerminalDelegationStatus).
    status: "running" | "done" | "failed" | "interrupted";
    result?: string;
    reasoningLevel?: string;
    tokens?: number;
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
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(p.reasoningLevel !== undefined ? { reasoningLevel: p.reasoningLevel } : {}),
      ...(p.tokens !== undefined ? { tokens: p.tokens } : {}),
    },
  }),
  /**
   * The workflow engine's run journal (plan 21 M4), streamed onto the session log keyed by `runId`.
   * `workflow.agent` carries a deterministic call ORDINAL (D-019) - one per leaf INVOCATION, so two
   * identical parallel leaves and a worker-plus-retry get distinct keys - plus the `(prompt,opts)`
   * fingerprint (the per-ordinal resume invalidation check) and the leaf's `Usage` (restored on resume
   * so budget-dependent loops replay). `workflow.leaf-failed` carries the fail-soft typed cause (D-008).
   */
  workflowStarted: (p: { runId: string; workflow: string; args?: unknown }): TrevorEventInput => ({
    type: "workflow.started",
    payload: {
      runId: p.runId,
      workflow: p.workflow,
      ...(p.args !== undefined ? { args: p.args } : {}),
    },
  }),
  workflowPhase: (p: { runId: string; title: string }): TrevorEventInput => ({
    type: "workflow.phase",
    payload: { runId: p.runId, title: p.title },
  }),
  workflowAgent: (p: {
    runId: string;
    ordinal: readonly number[];
    fingerprint: string;
    status: "completed" | "replayed";
    usage: { readonly input: number; readonly output: number };
    /** The serialized typed leaf result (success or typed failure) - the resume cache reconstructs it. */
    result: unknown;
  }): TrevorEventInput => ({
    type: "workflow.agent",
    payload: {
      runId: p.runId,
      ordinal: [...p.ordinal],
      fingerprint: p.fingerprint,
      status: p.status,
      usage: { input: p.usage.input, output: p.usage.output },
      result: p.result,
    },
  }),
  workflowLeafFailed: (p: {
    runId: string;
    kind: string;
    cause: string;
    childSessionId: string;
    detail?: unknown;
  }): TrevorEventInput => ({
    type: "workflow.leaf-failed",
    payload: {
      runId: p.runId,
      kind: p.kind,
      cause: p.cause,
      childSessionId: p.childSessionId,
      ...(p.detail !== undefined ? { detail: p.detail } : {}),
    },
  }),
  workflowLog: (p: { runId: string; message: string }): TrevorEventInput => ({
    type: "workflow.log",
    payload: { runId: p.runId, message: p.message },
  }),
  workflowCompleted: (p: { runId: string; ok: boolean; leaves: number }): TrevorEventInput => ({
    type: "workflow.completed",
    payload: { runId: p.runId, ok: p.ok, leaves: p.leaves },
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
    steered?: boolean;
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
      // Closed by the user steering (Esc with queued prompts: fold + cancel + submit in one
      // action). Rendered as a muted "steered" note, not the alarming red "cancelled".
      ...(p.steered ? { steered: true } : {}),
      ...(p.noReply ? { noReply: true } : {}),
      // Step count when the turn was budget-terminated (step backstop or context gate);
      // omitted on a normal turn. A forced final answer still streams; this flags WHY.
      ...(p.stepLimit ? { stepLimit: p.stepLimit } : {}),
      ...(p.stop ? { stop: p.stop } : {}),
      ...(p.diagnostic ? { diagnostic: p.diagnostic } : {}),
    },
  }),
  /** User asked to cancel the active run (hard steering / ESC). When `steered` is true the
   *   cancel is part of a steer (fold + cancel + submit); the host closes the run as `steered`
   *   instead of `cancelled` so the transcript shows a muted note, not the alarming red. */
  userCancel: (p: { runId: string; steered?: boolean }): TrevorEventInput => ({
    type: "user.cancel",
    payload: { runId: p.runId, ...(p.steered ? { steered: true } : {}) },
  }),
  /**
   * Retracts one or more queued `user.message`s from the durable follow-up queue (plan 47 D-003): the
   * FIRST event-to-event reference in the protocol. `supersedes` names the retracted messages by their
   * durable `eventId`; the catch-up predicate and the host history projection then treat those messages
   * as not-to-run and drop them from the prompt (the append-only-log equivalent of removing them from the
   * queue - the log is never mutated). It carries NO replacement itself: the Escape-fold publishes its
   * folded steering prompt as an ordinary `user.message` alongside this (so it reuses the normal turn
   * machinery), and this event only records the retraction. `reason` distinguishes fold / unqueue /
   * recall for observability + rendering. A superseded message already attempted (an assistant.started
   * landed for it) is a no-op - the attempt watermark wins - so this never yanks a running turn.
   */
  userSupersede: (p: {
    supersedes: readonly string[];
    reason: SupersedeReason;
  }): TrevorEventInput => ({
    type: "user.supersede",
    payload: { supersedes: [...p.supersedes], reason: p.reason },
  }),
  /**
   * A request to switch the active turn's model/reasoning mid-flight (plan 09.1): the control event the
   * UI selector (and later the auto-router) sends, keyed to the in-flight `runId`. The host routes it to
   * that turn's switch cell, which the loop reads at the next step boundary; a request with no matching
   * active turn is a loop no-op. `model` is the target ref (its `reasoning` is the requested level).
   */
  modelSwitchRequested: (p: {
    runId: string;
    model: ModelRef;
    initiator: ModelSwitchInitiator;
  }): TrevorEventInput => ({
    type: "model.switch.requested",
    payload: { runId: p.runId, model: p.model, initiator: p.initiator },
  }),
  /** Browser invokes an immediate host command, bypassing the model/turn queue. */
  userCommand: (p: { command: string; args: string }): TrevorEventInput => ({
    type: "user.command",
    payload: { command: p.command, args: p.args },
  }),
  /** Host's immediate result for a user.command (rendered, never fed to the model). An optional nested
   *  command-menu payload lets a host-owned command family (e.g. `/style`) render structured choices. */
  commandResult: (p: {
    command: string;
    text: string;
    ok: boolean;
    menu?: CommandMenuPayload;
  }): TrevorEventInput => ({
    type: "command.result",
    payload: { command: p.command, text: p.text, ok: p.ok, ...(p.menu ? { menu: p.menu } : {}) },
  }),
  /**
   * Host-authored session handoff. Used by /clear to move the browser into a newly minted durable
   * session after the leader has ensured it and spawned an attached replacement host. `handoff` is the
   * continuation handoff (02): the browser follows into the target session the leader prepared.
   */
  sessionSwitch: (p: {
    sessionId: string;
    reason: "clear" | "cd" | "resume" | "worktree" | "handoff";
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
   * The lineage record for a FORKED session (plan 15): the child's log records the parent it branched from
   * and the parent seq it branched at ("branch from here"). Emitted ONCE on the CHILD session as its first
   * event, so replaying the child alone recovers its origin and the inventory can surface parent→child
   * lineage - all through the generic append API, with no fork columns in the store.
   */
  sessionForkedFrom: (p: { parentSessionId: string; forkSeq: number }): TrevorEventInput => ({
    type: "session.forkedFrom",
    payload: { parentSessionId: p.parentSessionId, forkSeq: p.forkSeq },
  }),
  /**
   * The TANGENT lineage record (plan 37): marks a session as a tangent branched from a SELECTED piece
   * of a parent's transcript. Emitted ONCE on the CHILD (tangent) session as its first event. Unlike a
   * fork (`session.forkedFrom`), a tangent does NOT copy the parent transcript - it records only the
   * anchor (`parentSessionId`, the `sourceMessageId` the selection came from, and the selected `quote`
   * snapshot) for navigation, attribution, and a later EXPLICIT fold-back. The metadata is NOT
   * permission to include the parent transcript in the tangent prompt (D-001). `label` is an optional
   * user title. The tangent's creation time is the event's own `createdAt` (never duplicated here).
   */
  sessionTangentOf: (p: {
    parentSessionId: string;
    sourceMessageId: string;
    quote: string;
    label?: string;
  }): TrevorEventInput => ({
    type: "session.tangentOf",
    payload: {
      parentSessionId: p.parentSessionId,
      sourceMessageId: p.sourceMessageId,
      quote: p.quote,
      ...(p.label ? { label: p.label } : {}),
    },
  }),
  /**
   * An EXPLICIT tangent fold-back (plan 37, M8): the durable, auditable record that the user deliberately
   * carried a chosen piece of a tangent's outcome (a `quote`/`message`/`summary`) back toward the PARENT
   * session. It is NOT an automatic merge and NOT hidden context: the folded content is placed into the
   * parent COMPOSER as editable text for the user to review and submit (or discard), never becoming parent
   * prompt history on its own. Recorded on the TANGENT session's log (never the parent's), so it can never
   * reach the parent's model context; `preview` is a bounded snippet for observability, not the transcript.
   */
  tangentFoldedBack: (p: {
    tangentSessionId: string;
    parentSessionId: string;
    mode: TangentFoldMode;
    preview: string;
  }): TrevorEventInput => ({
    type: "tangent.foldedBack",
    payload: {
      tangentSessionId: p.tangentSessionId,
      parentSessionId: p.parentSessionId,
      mode: p.mode,
      preview: p.preview,
    },
  }),
  /**
   * A LUCID artifact was published into the session (plan 27, M2/M6): the agent (or an external/import
   * path) produced or re-produced an addressable HTML artifact. `lucidId` is the STABLE per-artifact
   * identity across versions; `version` increments per revision; `htmlHash` is the HTML blob's sha256;
   * `provenance`/`title` describe it. The web surfaces it as a transcript artifact card that opens the
   * Lucid viewer in the artifact panel - NOT a separate `lucid open` browser tab. A later publish with
   * the same `lucidId` and a higher `version` is the live-reload/version-swap (M6).
   */
  lucidPublished: (p: {
    lucidId: string;
    version: number;
    htmlHash: string;
    provenance: LucidProvenance;
    title?: string;
  }): TrevorEventInput => ({
    type: "lucid.published",
    payload: {
      lucidId: p.lucidId,
      version: p.version,
      htmlHash: p.htmlHash,
      provenance: p.provenance,
      ...(p.title ? { title: p.title } : {}),
    },
  }),
  /**
   * Located LUCID review feedback delivered to the agent (plan 27, M5): the STRUCTURED batch of
   * element/text-range annotations (id, anchor, snippet, note) the human composed against `version`,
   * plus an optional non-located `message` and a monotonic `cursor` that orders deliveries. This is
   * DATA the agent consumes, NOT prompt text: the host projects it through a safe, clearly-fenced
   * frame (`formatLucidFeedbackForPrompt`) so a note can never act as a top-level instruction.
   */
  lucidFeedback: (p: {
    lucidId: string;
    version: number;
    cursor: number;
    annotations: readonly LucidDeliveredAnnotation[];
    message?: string;
  }): TrevorEventInput => ({
    type: "lucid.feedback",
    payload: {
      lucidId: p.lucidId,
      version: p.version,
      cursor: p.cursor,
      annotations: p.annotations,
      ...(p.message ? { message: p.message } : {}),
    },
  }),
  /**
   * A LUCID review lifecycle change (plan 27, M6): the human `resolved` the review (approved / done)
   * or reopened it (`resolved: false`). Distinct from a feedback delivery - it carries no annotations,
   * only the status transition - so the agent knows it can stop iterating (resolved) or that
   * post-approval feedback is coming (reopened). `cursor` orders it in the delivery stream.
   */
  lucidReview: (p: { lucidId: string; resolved: boolean; cursor: number }): TrevorEventInput => ({
    type: "lucid.review",
    payload: { lucidId: p.lucidId, resolved: p.resolved, cursor: p.cursor },
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
  /**
   * The `@`-file-mention picker (plan 30) asks the live leader for the workspace file INDEX. A
   * side-channel request (like editor.open / user.shell), published ONCE per session the first time
   * `@` is used; `requestId` pairs it with its `file.index.result`. The browser then fuzzy-filters the
   * cached index locally per keystroke, so no per-keystroke traffic hits the log. It never reaches the
   * model or the transcript.
   */
  fileIndexRequested: (p: { requestId: string }): TrevorEventInput => ({
    type: "file.index.requested",
    payload: { requestId: p.requestId },
  }),
  /**
   * The live leader's workspace file index for a {@link fileIndexRequested} (paired by `requestId`):
   * the capped list of workspace-relative POSIX paths the `@`-mention picker searches. Advisory /
   * presence-style - kept OUT of conversation memory / prompt-history projection (like host.internet),
   * carrying relative paths only (never contents, never an absolute or escaping path). `truncated` is
   * true when the workspace has more files than the cap, so the search slice is incomplete.
   */
  fileIndexResult: (p: {
    requestId: string;
    files: readonly FileMatch[];
    truncated: boolean;
  }): TrevorEventInput => ({
    type: "file.index.result",
    payload: {
      requestId: p.requestId,
      files: p.files.map((f) => f.path),
      truncated: p.truncated,
    },
  }),
  /**
   * The supervisor side-channel (plan 44.1). The browser publishes these on the reserved
   * SUPERVISOR_SESSION_ID control session; the supervisor daemon answers with the paired result.
   * Modeled on file.index.* - `requestId` pairs a result to its request, and they are purely a
   * request/response side-channel (they never reach the model, transcript, or memory projection).
   *
   * `session.launch.requested`: spawn-or-reuse a host for `root`. The `result` carries the derived
   * `sessionId` the browser navigates to; the freshly spawned host announces `host.online` on its OWN
   * session, so the control session stays a side-channel and the presence path is unchanged.
   */
  sessionLaunchRequested: (p: { requestId: string; root: string }): TrevorEventInput => ({
    type: "session.launch.requested",
    payload: { requestId: p.requestId, root: p.root },
  }),
  sessionLaunchResult: (p: {
    requestId: string;
    sessionId: string;
    status: SessionLaunchStatus;
    error?: string;
  }): TrevorEventInput => ({
    type: "session.launch.result",
    payload: {
      requestId: p.requestId,
      sessionId: p.sessionId,
      status: p.status,
      ...(p.error ? { error: p.error } : {}),
    },
  }),
  /**
   * `folder.pick.requested`: the browser asks the (local) supervisor to pop the native OS folder
   * picker; the `result` returns the chosen POSIX `path` or `cancelled: true`. Best-effort and
   * local-only - a non-local / headless supervisor answers `cancelled` so the browser falls back to
   * paste-a-path (44.2).
   */
  folderPickRequested: (p: { requestId: string }): TrevorEventInput => ({
    type: "folder.pick.requested",
    payload: { requestId: p.requestId },
  }),
  folderPickResult: (p: {
    requestId: string;
    path?: string;
    cancelled: boolean;
  }): TrevorEventInput => ({
    type: "folder.pick.result",
    payload: {
      requestId: p.requestId,
      cancelled: p.cancelled,
      ...(p.path ? { path: p.path } : {}),
    },
  }),
  /**
   * `projects.list.requested`: the browser asks the supervisor for the recent project roots from the
   * launcher's `projects.json`; the `result` returns them recency-sorted (newest `updatedAt` first),
   * empty when the registry is absent.
   */
  projectsListRequested: (p: { requestId: string }): TrevorEventInput => ({
    type: "projects.list.requested",
    payload: { requestId: p.requestId },
  }),
  projectsListResult: (p: {
    requestId: string;
    projects: readonly SupervisorProject[];
  }): TrevorEventInput => ({
    type: "projects.list.result",
    payload: {
      requestId: p.requestId,
      projects: p.projects.map((proj) => ({
        root: proj.root,
        sessionId: proj.sessionId,
        updatedAt: proj.updatedAt,
      })),
    },
  }),
  /**
   * The whole task checklist after a change - a snapshot the UI renders and the host restores from.
   * `rev` is the registry's monotonic revision at emit time; a stale snapshot (lower rev arriving
   * later, e.g. on replay) is then rejected rather than clobbering newer state. Omitted for a legacy
   * caller, which decodes to LEGACY_TASK_REVISION. <!-- D-004 -->
   */
  tasksCurrent: (p: { tasks: readonly TaskSnapshot[]; rev?: number }): TrevorEventInput => ({
    type: "tasks.current",
    payload: { tasks: p.tasks, ...(p.rev !== undefined ? { rev: p.rev } : {}) },
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
  /**
   * A redacted tool-call guardrail marker (plan 07, D-005/D-008): the per-turn controller flagged a
   * repeating tool path (a repeated exact failure, or a read-only call returning the same result with
   * no progress). It carries ONLY the redacted observability surface - the decision `action`, the
   * `reason` code, the repeat `count`, the tool `name`, and short args/result/failure fingerprints -
   * keyed by the same `runId`/`callId` as the tool it annotates. Raw arguments and raw output never
   * ride this event; the model-facing guidance is appended to the tool result instead, not here.
   */
  toolGuardrail: (p: {
    runId: string;
    callId: string;
    name: string;
    action: string;
    reason: string;
    count: number;
    argsFingerprint: string;
    resultFingerprint?: string;
    failureFingerprint?: string;
  }): TrevorEventInput => ({
    type: "tool.guardrail",
    payload: {
      runId: p.runId,
      callId: p.callId,
      name: p.name,
      action: p.action,
      reason: p.reason,
      count: p.count,
      argsFingerprint: p.argsFingerprint,
      ...(p.resultFingerprint ? { resultFingerprint: p.resultFingerprint } : {}),
      ...(p.failureFingerprint ? { failureFingerprint: p.failureFingerprint } : {}),
    },
  }),
  /**
   * A visible hook decision (plan 25 M9, D-009): one PreToolUse/Stop hook's effect on the run -
   * a deny/halt block, a bounded context note or allowlisted input rewrite, a Stop continuation
   * request, or a diagnostic state (timeout/error/unapproved/trust-changed). `hookId` is the
   * hook's approval key (`<source>:<id>`); `reason` is already redacted and bounded at the host
   * boundary. An `allow` never rides this event (log-only - per-tool-call allows are noise).
   */
  hookDecision: (p: {
    runId: string;
    hookId: string;
    event: HookDecisionEventName;
    decision: HookDecisionKind;
    toolName?: string;
    reason?: string;
  }): TrevorEventInput => ({
    type: "hook.decision",
    payload: {
      runId: p.runId,
      hookId: p.hookId,
      event: p.event,
      decision: p.decision,
      ...(p.toolName ? { toolName: p.toolName } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
    },
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
  /**
   * A turn's local-model admission status (plan 11 M7): emitted when a turn QUEUES for a busy local
   * runtime ("waiting for LM Studio"), then when it is granted (`acquired`), and when the wait/hold ends
   * (`released`/`cancelled`) or is `refused`. Advisory/presence-style live status - kept OUT of
   * conversation memory / prompt-history projection (like host.internet); it never becomes durable
   * assistant content. `position` is the 0-based queue spot when queued; `refusal` the class when refused.
   */
  admissionStatus: (p: {
    runId: string;
    phase: "queued" | "acquired" | "released" | "refused" | "cancelled";
    provider: string;
    model: string;
    priority: string;
    position?: number;
    refusal?: string;
  }): TrevorEventInput => ({
    type: "admission.status",
    payload: {
      runId: p.runId,
      phase: p.phase,
      provider: p.provider,
      model: p.model,
      priority: p.priority,
      ...(p.position !== undefined ? { position: p.position } : {}),
      ...(p.refusal !== undefined ? { refusal: p.refusal } : {}),
    },
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
    /** Whether the host's Vim-mode prompt preference is enabled (plan 06), so the web gates the
     *  composer's opt-in Vim motions on a host-owned setting instead of browser state. */
    vimEnabled?: boolean;
    /** The host's tracked background jobs (plan 09), so the support panel renders promoted jobs live. */
    jobs?: readonly JobSnapshot[];
    /** The host-owned model preference (plan 51): the durable DEFAULT model (the one a fresh session
     *  starts on) + the FAVORITES (pinned). The browser reads default/favorites from here instead of a
     *  per-browser localStorage blob; omitted by a host that predates the preference (back-compat). */
    modelPrefs?: { default: ModelRef | null; pinned: readonly ModelRef[] };
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
      ...(p.vimEnabled !== undefined ? { vimEnabled: p.vimEnabled } : {}),
      ...(p.jobs ? { jobs: p.jobs } : {}),
      ...(p.modelPrefs ? { modelPrefs: p.modelPrefs } : {}),
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
   * Continuation handoff (02): create a clean prompt for a FRESH target session from the current one.
   * The lifecycle rides the source session's log - requested -> generating -> generated -> (approved /
   * rejected / failed) -> accepted - then the host ensures the target, appends its provenance + first
   * `user.message`, and publishes `session.switch`. `proposed` marks a model-initiated request (which
   * needs explicit approval); the generated/approved/accepted prompt is a control field, never a
   * source-session transcript item (it renders only as the target's first prompt).
   */
  handoffRequested: (p: {
    handoffId: string;
    mode: HandoffMode;
    sourceSessionId: string;
    prompt?: string;
    proposed?: boolean;
  }): TrevorEventInput => ({
    type: "handoff.requested",
    payload: {
      handoffId: p.handoffId,
      mode: p.mode,
      sourceSessionId: p.sourceSessionId,
      ...(p.prompt != null ? { prompt: p.prompt } : {}),
      ...(p.proposed ? { proposed: true } : {}),
    },
  }),
  /** Advisory progress while the model generates the target prompt (source-session feedback). */
  handoffGenerating: (p: { handoffId: string; detail?: string }): TrevorEventInput => ({
    type: "handoff.generating",
    payload: { handoffId: p.handoffId, ...(p.detail ? { detail: p.detail } : {}) },
  }),
  /** The target prompt was generated. `prompt` is a control field (not a source transcript item). */
  handoffGenerated: (p: {
    handoffId: string;
    prompt: string;
    summary?: string;
  }): TrevorEventInput => ({
    type: "handoff.generated",
    payload: {
      handoffId: p.handoffId,
      prompt: p.prompt,
      ...(p.summary ? { summary: p.summary } : {}),
    },
  }),
  /** The user approved a model-initiated handoff; `prompt` overrides the generated text when edited. */
  handoffApproved: (p: { handoffId: string; prompt?: string }): TrevorEventInput => ({
    type: "handoff.approved",
    payload: { handoffId: p.handoffId, ...(p.prompt != null ? { prompt: p.prompt } : {}) },
  }),
  /** The user rejected a model-initiated handoff; the source session stays active. */
  handoffRejected: (p: { handoffId: string; reason?: string }): TrevorEventInput => ({
    type: "handoff.rejected",
    payload: { handoffId: p.handoffId, ...(p.reason ? { reason: p.reason } : {}) },
  }),
  /** The handoff failed (empty direct prompt, generation error, target ensure/attach); source stays. */
  handoffFailed: (p: { handoffId: string; code: string; detail?: string }): TrevorEventInput => ({
    type: "handoff.failed",
    payload: { handoffId: p.handoffId, code: p.code, ...(p.detail ? { detail: p.detail } : {}) },
  }),
  /** The handoff was accepted: the host has ensured `targetSessionId` and will inject `prompt` there. */
  handoffAccepted: (p: {
    handoffId: string;
    targetSessionId: string;
    prompt: string;
  }): TrevorEventInput => ({
    type: "handoff.accepted",
    payload: { handoffId: p.handoffId, targetSessionId: p.targetSessionId, prompt: p.prompt },
  }),
  /**
   * A loop lifecycle STATUS event (plan 17): the host publishes one whenever a loop transitions, carrying
   * the full {@link LoopSnapshot} the client renders. A `pending` snapshot IS the confirmation request; a
   * terminal snapshot carries the stop reason/error. The client drives create/confirm/edit/cancel/controls
   * back through the command surface, and the host re-publishes the resulting status.
   */
  loopStatus: (p: { snapshot: LoopSnapshot }): TrevorEventInput => ({
    type: "loop.status",
    payload: { snapshot: p.snapshot },
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

/**
 * The non-lifecycle event types the inventory read model projects per session (D-090): the latest
 * host.online (cwd/workspace/git), the first user.message (title), and the archive/title/delete
 * markers. Owned here beside the event constructors and typed as `DecodedEvent["type"]`, so each
 * name can only ever be a real protocol event, never a bare literal that drifts from its constructor.
 */
export const INVENTORY_EVENT_TYPES = {
  hostOnline: "host.online",
  userMessage: "user.message",
  sessionArchived: "session.archived",
  sessionTitle: "session.title",
  sessionDeleted: "session.deleted",
  sessionForkedFrom: "session.forkedFrom",
  sessionTangentOf: "session.tangentOf",
} as const satisfies Readonly<Record<string, DecodedEvent["type"]>>;
