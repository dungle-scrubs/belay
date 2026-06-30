import type { ProviderDiagnostic, ProviderPartialCounts, TurnStop } from "@trevor/session";
import { Clock, Deferred, Duration, Effect, Option, Ref, Stream } from "effect";
import { envNumber } from "../env";
import { debug, warn } from "../log";
import type {
  ChatMessage,
  ModelEvent,
  Provider,
  ProviderError,
  ProviderEvent,
  ToolCall,
  ToolDef,
} from "../providers";
import {
  ProviderUnavailable,
  protocolAnomalyDiagnostic,
  providerDiagnostic,
  providerFailureEvidence,
} from "../providers";
import { buildProviderFailureLogFields } from "../providers/failure-record-schema";
import { recordObservation } from "../providers/observation-store";
import {
  classifyProviderProtocolAnomaly,
  type ProviderProtocolDiagnostic,
} from "../providers/protocol-anomaly";
import { executeTool, offeredToolDefs, READ_ONLY_TOOLS } from "../tools";
import { trimLargestToolResult } from "./overflow-recovery";
import { cheapestReasoning, reduceReasoning } from "./reasoning-levels";
import type { SwitchCell, SwitchRequest } from "./switch-cell";
import {
  createToolGuardrails,
  type GuardrailConfig,
  type GuardrailDecision,
} from "./tool-guardrails";
import { deriveTurnBudget, EMERGENCY_MAX_STEPS, type TurnBudget } from "./turn-budget";
import { TurnTerminationGate } from "./turn-policy";

/**
 * Emits the structured, redacted provider-failure log line (D-076 M6): the classification, retry
 * decision, attempt number, source/model, phase, and stable fingerprint - behind the verbose
 * `provider` debug scope, where the richer shape metadata (status/code/field names) is useful. Never
 * logs a raw payload; the detail is re-redacted by the field builder.
 */
function logProviderFailure(
  provider: Provider,
  error: ProviderError,
  attempt: number,
  outcome: "reconnect" | "terminal",
): void {
  debug(
    "provider",
    outcome === "reconnect" ? "reconnect" : "failure",
    buildProviderFailureLogFields({
      ...providerFailureEvidence(error),
      provider: provider.id,
      model: provider.model,
      phase: "model-step",
      attempt,
      outcome,
    }),
  );
}

/**
 * Best-effort: when a model step fails terminally with an UNKNOWN provider failure shape, record it
 * as a redacted, deduped observation under TREVOR_STATE_HOME (D-076 M5). Emits nothing and never
 * fails - the underlying store swallows any write error - so it can be `concat`-ed ahead of the real
 * failure without changing the turn's outcome. Only `unknown` is observed; well-classified terminal
 * failures (auth, quota, model/runtime unavailable, request rejected) already carry their own action.
 */
function observeUnknownFailure(
  provider: Provider,
  error: ProviderError,
  outputStarted: boolean,
): Stream.Stream<never, never> {
  if (error._tag !== "ProviderUnavailable" || error.classification !== "unknown") {
    return Stream.empty;
  }
  const evidence = providerFailureEvidence(error);
  return Stream.fromEffect(
    Effect.promise(() =>
      recordObservation(
        {
          provider: error.provider,
          model: provider.model,
          phase: "model-step",
          classification: "unknown",
          retryable: evidence.retryable,
          status: evidence.status,
          code: evidence.code,
          message: error.detail,
          shapeFields: evidence.shapeFields,
          outputStarted,
        },
        new Date().toISOString(),
      ),
    ),
  ).pipe(Stream.drain);
}

/**
 * Provider-stream idle watchdog (ms): if a model stream produces no event for this long, treat it as
 * a stalled (half-open) connection and fail it, so the loop retries or goes terminal instead of
 * hanging forever - the fix for the 18-minute "Working" stall where a half-open Codex stream sent no
 * tokens, close, or error. Env-overridable; set to 0 to disable. Default 90s (xhigh reasoning can
 * pause for a while, so the gap is generous - it only catches a genuinely dead stream).
 */
const DEFAULT_STREAM_STALL_MS = envNumber("TREVOR_STREAM_STALL_MS", 90_000);

/**
 * Per-tool-call wall-clock watchdog (ms): the tool-side analog of the provider-stream idle watchdog
 * above, which only covers the MODEL stream - not tool execution. A tool that returns no result for
 * this long is treated as a hung call (a half-open socket, a wedged subprocess, a delegation waiting on
 * a dead child) and aborted, so the loop continues instead of latching "Working" forever. Generous by
 * default: bash self-bounds at 30s (run-shell.ts) and reads/greps/edits are local, so the ceiling only
 * trips on a genuine hang, never on legitimately slow work. Env-overridable; set to 0 to disable.
 * Default 300s.
 */
const DEFAULT_TOOL_STALL_MS = envNumber("TREVOR_TOOL_STALL_MS", 300_000);

/**
 * Tools that block by design and must be EXEMPT from the per-tool stall watchdog: `ask_user` pauses the
 * turn on a human answer with no upper bound (a slow human is not a hung tool). Delegation tools are not
 * listed because the loop routes them to the injected runner (not `executeTool`), where the child turn's
 * own stream + tool watchdogs bound them transitively - capping them here too would double-bound a
 * legitimately long child.
 */
const UNBOUNDED_TOOLS: ReadonlySet<string> = new Set(["ask_user"]);

/** The progress guard threshold (02.17 D-003): a step-budget checkpoint auto-continues only if the
 *  prompt grew by at least this many tokens since the previous checkpoint. Tiny relative to a real
 *  work window (thousands of tokens of tool results), so genuine work always clears it; a diverse-no-op
 *  loop that the same-tool stall detector misses adds ~0 and trips it, pausing instead of running to
 *  the emergency ceiling. */
const CHECKPOINT_MIN_ADVANCE_TOKENS = 1_024;

export interface TurnLoopConfig {
  /** Absolute runaway ceiling, independent of the adaptive per-step budget (D-011): the loop derives
   *  an effective step budget each round (see turn-budget.ts) and clamps it to never exceed this. Only
   *  binds when the adaptive budget would exceed it or telemetry is unusable - the genuine backstop. */
  readonly emergencyMaxSteps: number;
  /** Max read-only tool calls a single step runs concurrently. */
  readonly toolConcurrency: number;
  /** Prompt-token fraction of the context window where the loop stops opening tool rounds. */
  readonly contextBudgetFraction: number;
  /** Per-turn cap on in-loop overflow-recovery adjustments. */
  readonly maxRecovery: number;
  /** Provider-stream idle watchdog in ms; 0 disables it. */
  readonly streamStallMs: number;
  /** Per-tool-call wall-clock watchdog in ms; 0 disables it. */
  readonly toolStallMs: number;
  /** Reconnect backoff before retries; length + 1 is the attempt budget. */
  readonly reconnectBackoffsMs: readonly number[];
}

export const DEFAULT_TURN_LOOP_CONFIG: TurnLoopConfig = {
  emergencyMaxSteps: EMERGENCY_MAX_STEPS,
  toolConcurrency: 8,
  contextBudgetFraction: 0.8,
  maxRecovery: 2,
  streamStallMs: DEFAULT_STREAM_STALL_MS,
  toolStallMs: DEFAULT_TOOL_STALL_MS,
  // 9 backoffs -> 10 total attempts (the initial + 9 retries). The curve ramps then caps at 15s, for
  // ~75s cumulative across all retries - deliberately under the 90s per-attempt stream-stall watchdog,
  // so the watchdog still bounds any single hung attempt while a genuinely flaky upstream gets a wide
  // budget to recover. Retries fire only before any token streams (safeToRetry), so the wider budget
  // never duplicates partial output. <!-- D-001 D-002 -->
  reconnectBackoffsMs: [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000],
};

function turnLoopConfig(overrides?: Partial<TurnLoopConfig>): TurnLoopConfig {
  return {
    ...DEFAULT_TURN_LOOP_CONFIG,
    ...overrides,
    reconnectBackoffsMs:
      overrides?.reconnectBackoffsMs ?? DEFAULT_TURN_LOOP_CONFIG.reconnectBackoffsMs,
  };
}

/**
 * Wraps a provider stream with the idle watchdog: a scoped fiber polls the time since the last event
 * and, past the configured stall timeout, fails the stream with a RETRYABLE ProviderUnavailable. The loop's
 * existing reconnect `catchAll` then retries (when nothing has streamed yet) or, once tokens have
 * flowed, surfaces it as a clear terminal error. A normal end, the stall failure, or an interrupt
 * (ESC/cancel) all close the stream scope and tear the watchdog down.
 */
function withStallTimeout<A>(
  source: Stream.Stream<A, ProviderError>,
  providerName: string,
  streamStallMs: number,
): Stream.Stream<A, ProviderError> {
  if (streamStallMs <= 0) {
    return source;
  }
  return Stream.unwrapScoped(
    Effect.gen(function* () {
      const lastSeen = yield* Ref.make(yield* Clock.currentTimeMillis);
      const stalled = yield* Deferred.make<never, ProviderError>();
      const bump = Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(lastSeen, now)));
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(Duration.millis(Math.min(streamStallMs, 5_000)));
            const idle = (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastSeen));
            if (idle >= streamStallMs) {
              yield* Deferred.fail(
                stalled,
                new ProviderUnavailable({
                  provider: providerName,
                  detail: `model stream stalled (no output for ${Math.round(streamStallMs / 1000)}s)`,
                  retryable: true,
                }),
              );
              return;
            }
          }
        }),
      );
      const guarded = source.pipe(Stream.tap(() => bump));
      const failOnStall: Stream.Stream<never, ProviderError> = Stream.fromEffect(
        Deferred.await(stalled),
      );
      // haltStrategy "left": the merged stream ends when the SOURCE ends (we don't wait on the
      // never-resolving watchdog); a stall failure still propagates immediately from either side.
      return Stream.merge(guarded, failOnStall, { haltStrategy: "left" });
    }),
  );
}

/**
 * Wraps a single tool-call execution with the per-tool wall-clock watchdog (`toolStallMs`). Unlike the
 * provider-stream watchdog this does NOT fail the turn: `executeTool` resolves to a string and never
 * throws, so on timeout we resolve to an `error:` string the model reads as the tool result. The turn
 * keeps going - the other concurrent results in the batch still commit, and the model gets to react to
 * the timeout - rather than the whole turn going terminal or latching "Working" forever.
 *
 * `toolStallMs <= 0` disables it; tools in {@link UNBOUNDED_TOOLS} are passed through (they block by
 * design). The timeout interrupts the tool's Effect, which frees the loop; an underlying uncancelable
 * promise (a raw fetch, a detached subprocess) may still run to completion in the background, but it no
 * longer blocks the turn.
 */
export function withToolStallTimeout(
  name: string,
  effect: Effect.Effect<string>,
  toolStallMs: number,
): Effect.Effect<string> {
  if (toolStallMs <= 0 || UNBOUNDED_TOOLS.has(name)) {
    return effect;
  }
  return effect.pipe(
    Effect.timeoutTo({
      duration: Duration.millis(toolStallMs),
      onSuccess: (result: string) => result,
      onTimeout: () => {
        warn("tool", "stalled", { name, ms: toolStallMs });
        return (
          `error: tool "${name}" produced no result after ${Math.round(toolStallMs / 1000)}s and was ` +
          "aborted as a hung call; do not retry it blindly - try a different approach or a smaller scope"
        );
      },
    }),
  );
}

/**
 * Composes a guardrail decision onto the model-facing tool result (M4/M6 / D-007). A `warn` appends
 * the action-oriented guidance after the raw result, so the model both keeps the output and reads the
 * advice to change approach. A `block` (opt-in hard stop) SUBSTITUTES the synthetic, retryable
 * guidance for the repeated output: the tool still executed (D-003), but its stale repeat is withheld
 * so the model stops re-reading it and changes course; the turn continues normally toward synthesis or
 * a typed terminal stop. Any other action returns the raw result unchanged. The guidance names only the
 * tool and a count - never raw arguments or output - so it is safe on the tool result; the redacted
 * guardrail event (M5) is the separate telemetry surface.
 */
export function guardedToolResult(rawResult: string, decision: GuardrailDecision): string {
  if (decision.action === "warn" && decision.guidance) {
    return `${rawResult}\n\n${decision.guidance}`;
  }
  if (decision.action === "block" && decision.guidance) {
    return decision.guidance;
  }
  return rawResult;
}

/**
 * Bounded auto-reconnect for a transient provider outage (D-076…D-079): backoff (ms) BEFORE each
 * retry. Nine entries = ten total attempts (the initial plus nine retries), ramping then capped at 15s
 * for ~75s cumulative - under the 90s stream-stall watchdog that bounds each single attempt. A small
 * jitter is added so simultaneous turns don't reconnect in lockstep. The budget is per-step and
 * independent of the step and overflow-recovery budgets, so reconnection can never spin.
 */
/**
 * Heuristic: did the model END a turn by ANNOUNCING an imminent action without calling a tool?
 * A weaker model sometimes trails off ("Let me continue reading the remaining files:") and stops
 * instead of emitting the next tool batch, which the loop would otherwise accept as a final answer.
 * Deliberately conservative - it only fires on a clear trailing announcement (a dangling colon, or a
 * closing "let me read…/I'll continue…" clause), so a genuine final answer is never mistaken for one.
 * Worst case on a false positive is one wasted nudge step, bounded to once per turn.
 */
export function looksUnfinished(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(":")) {
    return true; // "...let me read these files:" - about to list/act, then stopped
  }
  const tail = trimmed.slice(-160).toLowerCase();
  return /\b(let me|i'?ll|i will|now i|next,? i)\b.{0,90}\b(continue|read|look|check|explore|examine|review|proceed|start|dive|go through)\b[^.!?]*$/.test(
    tail,
  );
}

/** One ordered segment of a step's tool batch: a maximal run of consecutive read-only calls
 *  (run concurrently) OR a single mutating call (a serial barrier). Each entry keeps the call's
 *  original index so its result commits to the right `conversation` slot in CALL order. */
type ToolSegment = ReadonlyArray<{ readonly call: ToolCall; readonly index: number }>;

/**
 * Partitions a step's tool batch into ordered segments for concurrent dispatch (D-050).
 * Consecutive read-only calls (per `READ_ONLY_TOOLS`) coalesce into one maximal run; every
 * mutating call breaks the run and forms its own singleton barrier. Segment order preserves
 * emission order, so a mutating call still executes in place relative to the reads around it.
 */
export function partitionToolCalls(calls: readonly ToolCall[]): readonly ToolSegment[] {
  const segments: { call: ToolCall; index: number }[][] = [];
  let run: { call: ToolCall; index: number }[] | null = null;
  calls.forEach((call, index) => {
    if (READ_ONLY_TOOLS.has(call.name)) {
      if (!run) {
        run = [];
        segments.push(run);
      }
      run.push({ call, index });
    } else {
      // A mutating call is its own barrier and ends any open read run.
      segments.push([{ call, index }]);
      run = null;
    }
  });
  return segments;
}

/** One event from the agent loop: the shared model-step events (`ModelEvent`: text,
 *  thinking, usage, overflow) forwarded unchanged from the provider, plus the loop-only
 *  cases - tool start/end (the loop turns a provider tool_call into these as it executes),
 *  a recovery adjustment (an in-turn overflow rung - distinct from compaction, the durable
 *  history summarization deferred to D-036), a `reconnecting` status (a transient provider outage
 *  is being auto-retried before any token streamed - D-076…D-079), a `step_limit` (the turn hit its
 *  budget and is forcing a final answer - D-051), or an empty answer. */
export type AgentEvent =
  | ModelEvent
  | { readonly type: "tool_start"; readonly call: ToolCall }
  | { readonly type: "tool_end"; readonly call: ToolCall; readonly result: string }
  | {
      /** A tool-call guardrail flagged a repeating path (07): the redacted decision for the call that
       *  just ran. `runAgent` emits this only for a non-`allow` decision; turn.ts maps it to the
       *  redacted `tool.guardrail` event (the model-facing guidance rides the tool result, not here). */
      readonly type: "guardrail";
      readonly call: ToolCall;
      readonly decision: GuardrailDecision;
    }
  | {
      readonly type: "recovered";
      readonly action: "trim" | "reduce-thinking";
      readonly detail: string;
      readonly reclaimed: number;
    }
  | {
      readonly type: "stop";
      readonly stop: TurnStop;
      /** Set only on a malformed-protocol terminal stop (D-005): the structured incident that rides
       *  onto the terminal `assistant.completed` so the web can render the anomaly with escaped markup
       *  and /doctor can correlate it. Absent on budget/context stops, which carry no provider error. */
      readonly diagnostic?: ProviderDiagnostic;
    }
  | { readonly type: "step_limit"; readonly steps: number }
  | {
      readonly type: "reconnecting";
      readonly attempt: number;
      /** Total attempt budget (initial + retries), so the UI shows a true `attempt/maxAttempts`. */
      readonly maxAttempts: number;
      readonly detail: string;
      readonly diagnostic?: ProviderDiagnostic;
    }
  | {
      /** A step-budget CHECKPOINT (02.17): the loop reached the adaptive budget with headroom + progress
       *  below the emergency ceiling, so it auto-continues and drops this quiet breadcrumb instead of
       *  pausing. A durable, non-terminating marker (modeled on `recovered`). */
      readonly type: "checkpoint";
      readonly steps: number;
      readonly pressure: number;
      readonly threshold: number;
      readonly detail: string;
    }
  | { readonly type: "empty" };

/**
 * The model<->tools loop as a Stream of AgentEvents: stream a model step; if it
 * requested tools, execute them (emitting start/end) and recurse; otherwise the model
 * answered and the stream ends. Bounded by the loop config to prevent runaway tool loops.
 *
 * Cancellation is fiber interruption: interrupting the consumer halts the recursion and
 * the in-flight provider stream tears its request down (A-004) - no manual abort checks.
 * `conversation`, and each step's `toolCalls`/`assistantText`, are mutable closures read
 * by the deferred (post-model-step) Stream stages after the model step has drained.
 */
/**
 * The delegation capability injected into a PARENT turn (D-048): the delegation tool defs to offer
 * (delegate_inline / delegate_background) and the runner that executes one. The loop intercepts a
 * call to a delegation tool and routes it here (the runner has the provider + transport + parent
 * context the generic tool executor lacks) instead of `executeTool`. A CHILD turn is given no
 * capability, which is how depth-1 is enforced structurally: a child can neither see nor invoke
 * delegation (D-048).
 */
export interface DelegateCapability {
  readonly defs: readonly ToolDef[];
  readonly names: ReadonlySet<string>;
  /** Runs one delegation tool-call, resolving to the model-facing tool result. */
  readonly run: (name: string, args: string) => Promise<string>;
}

/** Options for a turn: a subagent's tool allow-list, and (for a parent) the delegation capability. */
export interface RunAgentOptions {
  readonly toolNames?: ReadonlySet<string>;
  readonly delegate?: DelegateCapability;
  readonly loop?: Partial<TurnLoopConfig>;
  /** Carry-forward of the prior turn's measured prompt size + served window (03.1 D-002), from
   *  `CompactionController.usageSeed()`. Seeds the context-pressure gate so a turn inheriting >= the
   *  fraction synthesizes at step 0 instead of opening one mandatory tool round. Absent on a session's
   *  first turn (no prior usage) - the trackers then default to 0 and the loop behaves as today. */
  readonly seedUsage?: { readonly input: number; readonly contextWindow: number };
  /** Tool-call guardrail thresholds (07): partial overrides merged onto the controller defaults.
   *  Production leaves this absent (warn-first, hard stops off); a test tunes thresholds or flips
   *  `hardStop` on for the synthetic-block path. */
  readonly guardrails?: Partial<GuardrailConfig>;
  /** Test seam: overrides how a (non-delegation, allow-listed) tool call is executed, so a loop test
   *  can drive the guardrail with deterministic, hermetic tool results without touching the real
   *  executor. Absent in production - the real `executeTool` path (with the stall watchdog) runs. */
  readonly runTool?: (name: string, args: string, callId: string) => Effect.Effect<string>;
  /** The per-turn mid-turn-switch cell (plan 09.1): an external initiator (the UI selector now, the
   *  auto-router later) requests a model/reasoning change, which the loop applies at the next step
   *  boundary. Absent on a turn that cannot be switched (a subagent) - the loop behaves exactly as
   *  before. */
  readonly switch?: SwitchCell;
}

export function runAgent(
  provider: Provider,
  history: readonly ChatMessage[],
  reasoning?: string,
  runId?: string,
  useTools = true,
  opts: RunAgentOptions = {},
): Stream.Stream<AgentEvent, ProviderError> {
  const conversation: ChatMessage[] = [...history];
  const config = turnLoopConfig(opts.loop);
  // The model is OFFERED only the allow-listed tools; the executor enforces the same set below, so
  // a child can neither see nor run a tool outside its agent's allow-list. A parent additionally
  // gets the delegation tools (a child gets none - depth-1).
  const delegate = opts.delegate;
  const tools = offeredToolDefs(useTools, opts.toolNames, delegate?.defs);
  // The per-turn tool-call guardrail controller (07): it observes each completed tool call and returns
  // a typed, redacted decision the loop acts on (append guidance / synthetic block). Read-only purity
  // comes from the registry-derived set (D-006); thresholds default to warn-first with hard stops off.
  const guardrails = createToolGuardrails({
    readOnly: READ_ONLY_TOOLS,
    ...(opts.guardrails ? { config: opts.guardrails } : {}),
  });
  const executeOne =
    opts.runTool ??
    ((name: string, args: string, callId: string): Effect.Effect<string> =>
      withToolStallTimeout(name, executeTool(name, args, runId, callId), config.toolStallMs));
  const runTool = (name: string, args: string, callId: string): Effect.Effect<string> => {
    // A delegation tool-call is routed to the injected runner (it has the provider + transport the
    // generic executor lacks); everything else goes to the executor, gated by the allow-list. `callId`
    // is forwarded so a tool that needs the active tool-call id (ask_user) can correlate its UI events.
    if (delegate?.names.has(name)) {
      return Effect.promise(() => delegate.run(name, args));
    }
    if (opts.toolNames && !opts.toolNames.has(name)) {
      return Effect.succeed(`error: tool "${name}" is not available to this agent`);
    }
    return executeOne(name, args, callId);
  };
  // One retry budget for an empty answer (the model ending a turn with no text and no
  // tool calls). A single nudge often gets it to synthesize; if it stays empty we
  // surface it rather than ending silently.
  let emptyRetried = false;
  // One retry budget for a turn that ends with text but NO tool call where the text trails off
  // mid-task ("let me continue reading…") instead of finishing - nudge it once to actually act.
  let continueRetried = false;
  // One nudge budget for a malformed-protocol step (D-005): the model rendered raw tool-call markup
  // as assistant text instead of a typed tool call. A single nudge often gets it to use the typed
  // interface; a persistent anomaly then terminates with a diagnostic rather than nudging forever.
  let protocolNudged = false;

  // Graceful overflow recovery (D-034..D-038): in-loop, per-turn, cheap rungs only,
  // bounded so it can never spin. Recovery adjusts the reasoning level and the in-loop
  // tool results (everything appended after the prior history starts at baseIndex).
  const baseIndex = history.length;
  let recoveryBudget = config.maxRecovery;
  let currentReasoning = reasoning;
  let thinkingReduced = false;

  // The latest model step's prompt size + window, captured from its usage event (like
  // overflowReason). Drives the context-pressure budget (D-053): when the prompt that fed
  // the last step crosses the configured fraction of the window, the next round forces a
  // final answer instead of opening more tool calls. Seeded from the prior turn's measured usage
  // (03.1 D-002: `opts.seedUsage`, carried forward from CompactionController) so the gate can fire at
  // step 0 when the turn inherits >= the fraction; both default to 0 (a session's first turn has no
  // seed), so the loop behaves exactly as today until the first usage event of this turn arrives.
  let lastInputTokens = opts.seedUsage?.input ?? 0;
  let lastContextWindow = opts.seedUsage?.contextWindow ?? 0;
  let repeatedToolName: string | undefined;
  let repeatedToolSignature: string | undefined;
  let repeatedToolRounds = 0;

  // Step-backstop auto-continue (02.17): the adaptive budget is a re-evaluation CHECKPOINT, not a hard
  // pause. `grantedSteps` accumulates one tier-base worth per auto-continue so checkpoints are DISCRETE
  // (the active threshold is `effectiveMaxSteps + grantedSteps`, capped at the emergency ceiling);
  // `checkpointInputTokens` snapshots context at the last checkpoint so the progress guard can require
  // a non-trivial advance over the window. The emergency ceiling stays the sole step-axis terminator.
  let grantedSteps = 0;
  // Pre-baselined from the seed (03.1 D-003): when the turn carries forward the prior turn's measured
  // usage, the progress guard's baseline is the turn's STARTING context, so it measures growth from
  // turn start and the first real usage event does not re-baseline (the `!checkpointBaselined` guard
  // below is then a no-op). Without a seed both stay 0/false, so the first usage event baselines as
  // today and the loop is unchanged.
  let checkpointInputTokens = opts.seedUsage?.input ?? 0;
  let checkpointBaselined = opts.seedUsage !== undefined;

  // The adaptive per-step budget (D-009…D-013): derived fresh from the live facts (served context
  // window, prompt pressure, repeated-tool progress, reasoning level) so a large-context, low-pressure
  // turn gets far more room than the old static 32, while a near-overflow or near-stalled turn gets
  // less. The emergency ceiling (config) clamps it so a bad loop or unusable telemetry can never spin.
  // Read at each gate check, so it tracks the latest usage/repeat state.
  const currentBudget = (): TurnBudget =>
    deriveTurnBudget({
      providerId: provider.id,
      providerKind: provider.kind,
      model: provider.model,
      reasoning: currentReasoning,
      reasoningLevels: provider.reasoningLevels,
      inputTokens: lastInputTokens,
      contextWindow: lastContextWindow,
      contextBudgetFraction: config.contextBudgetFraction,
      repeatedToolName,
      repeatedToolRounds,
      emergencyMaxSteps: config.emergencyMaxSteps,
    });

  // The active CHECKPOINT threshold composes the accumulated grant onto the live adaptive budget,
  // capped at the emergency ceiling (02.17 D-005). Closes over the live `grantedSteps`, so a call
  // BEFORE a checkpoint grant and one AFTER it (the next-threshold recompute) read the same formula.
  const thresholdFor = (budget: TurnBudget): number =>
    Math.min(budget.emergencyMaxSteps, budget.effectiveMaxSteps + grantedSteps);

  // Derives the adaptive budget from the live facts and runs the termination gate against the SAME
  // facts in one call. The budget+gate pairing and the 7-field gate observation live here, so the
  // step backstop and the protocol-anomaly gate are each a one-liner that can't read a different set
  // of mutables than the budget was derived from.
  const assessTurn = (
    steps: number,
    providerDiagnostic?: ProviderProtocolDiagnostic,
  ): { stop: TurnStop | null; checkpoint: boolean; budget: TurnBudget; threshold: number } => {
    const budget = currentBudget();
    // The progress guard (D-003) measures the prompt's growth since the last checkpoint; the gate
    // auto-continues below the ceiling when it advanced.
    const threshold = thresholdFor(budget);
    const contextAdvanced =
      lastInputTokens - checkpointInputTokens >= CHECKPOINT_MIN_ADVANCE_TOKENS;
    const { stop, checkpoint } = TurnTerminationGate.assess({
      steps,
      maxSteps: threshold,
      inputTokens: lastInputTokens,
      contextWindow: lastContextWindow,
      contextBudgetFraction: config.contextBudgetFraction,
      repeatedToolName,
      repeatedToolRounds,
      budgetReason: budget.reason,
      emergencyMaxSteps: budget.emergencyMaxSteps,
      contextAdvanced,
      ...(providerDiagnostic ? { providerDiagnostic } : {}),
    });
    return { stop, checkpoint, budget, threshold };
  };

  // One overflow adjustment: mutate the conversation/reasoning in place and return a
  // `recovered` event, or null when nothing cheap is left. Cheapest-first and
  // provider-aware - cut thinking (the output lever) when the model hit the wall
  // mid-response and thinking is on, else trim the largest tool result (the input
  // lever). The expensive rungs (summarize history, raise the loaded window) are
  // deferred to backlog (D-036).
  const tryRecover = (reason: string): AgentEvent | null => {
    if (recoveryBudget <= 0) {
      return null;
    }
    const reduced = thinkingReduced
      ? null
      : reduceReasoning(provider.reasoningLevels, currentReasoning);
    const reduceThinking = (): AgentEvent => {
      currentReasoning = reduced ?? currentReasoning;
      thinkingReduced = true;
      recoveryBudget -= 1;
      return {
        type: "recovered",
        action: "reduce-thinking",
        detail: `reduced thinking to ${reduced}`,
        reclaimed: 0,
      };
    };
    // Hit the wall mid-response (output overran): cut thinking (the output lever) first.
    if (reason.includes("mid-response") && reduced !== null) {
      return reduceThinking();
    }
    // Otherwise the prompt itself is too big: trim the largest tool result (input lever).
    // Reducing thinking can't shrink the input, so it's not a fallback here - if there's
    // nothing to trim, recovery is done and the terminal overflow surfaces.
    const trim = trimLargestToolResult(conversation, baseIndex);
    if (trim) {
      recoveryBudget -= 1;
      return {
        type: "recovered",
        action: "trim",
        detail: `trimmed ${trim.tool} output`,
        reclaimed: trim.reclaimed,
      };
    }
    return null;
  };

  // Budget reached (step backstop or context gate): force ONE final answer instead of ending
  // silently on a tool stub (D-051, D-052). Tools are removed so the model must answer from
  // what it already gathered; a transient nudge is pushed into the LOCAL `conversation` only -
  // never emitted, never persisted (durable history is rebuilt from emitted events, not this
  // array). Reasoning is forced to the cheapest level, and it runs exactly once (no recursion,
  // no tools to recurse on). An empty result falls through to the `empty` -> noReply path, so a
  // capped turn still never dead-ends in silence. `step_limit` is emitted first as the
  // observable termination signal, then the forced answer streams as ordinary text.
  // One model step's watchdog-wrapped stream: the provider stream over the live conversation, guarded
  // by the stall timeout. The single owner of "how a model step is wrapped + observed"; each caller
  // pipes its own siphon (the synthesize and connect steps accumulate/forward different events).
  const modelStream = (
    stepTools: readonly ToolDef[],
    reasoning: string | undefined,
  ): Stream.Stream<ProviderEvent, ProviderError> =>
    withStallTimeout(
      provider.stream(conversation, stepTools, reasoning),
      provider.model,
      config.streamStallMs,
    );

  // Shared empty-answer recovery (03.1 D-004): the model ended a step with no text - either the
  // normal path (a stop token only) OR a forced synthesis. An empty answer is usually the accumulated
  // prior history poisoning the model into an immediate stop, so splice history down to just the
  // current task - drop everything before this turn's own user message, keeping the work it just did -
  // and run `retry` ONCE. The single `emptyRetried` budget is shared across both call sites, so a turn
  // never double-retries; once spent, the blank answer surfaces as `empty`. `retry` is the
  // path-specific re-run (the normal step, or a fresh tool-less synthesis attempt).
  const recoverEmptyAnswer = (
    retry: () => Stream.Stream<AgentEvent, ProviderError>,
  ): Stream.Stream<AgentEvent, ProviderError> => {
    if (emptyRetried) {
      return Stream.succeed<AgentEvent>({ type: "empty" });
    }
    emptyRetried = true;
    conversation.splice(0, Math.max(0, history.length - 1));
    return retry();
  };

  const synthesize = (n: number, stop: TurnStop): Stream.Stream<AgentEvent, ProviderError> =>
    Stream.suspend(() => {
      const synthReasoning = cheapestReasoning(provider.reasoningLevels);
      // One forced-answer attempt: push the "answer now, no tools" nudge (conversation-only - never
      // emitted, never persisted) and re-stream with zero tools at the cheapest reasoning. A blank
      // answer recovers through the shared empty-retry (splice + one more attempt, re-pushing the
      // nudge); a still-blank answer falls through to the `empty` -> noReply path.
      const attempt = (): Stream.Stream<AgentEvent, ProviderError> =>
        Stream.suspend(() => {
          conversation.push({
            role: "user",
            content:
              "You have reached your tool-call budget for this turn. Do not call any more tools. " +
              "Answer the original request now, as completely as you can from what you have already gathered.",
          });
          let answer = "";
          const model = modelStream([], synthReasoning).pipe(
            Stream.filterMap((event) => {
              // Tools were removed; drop any stray tool_call/overflow and keep text/thinking/usage.
              if (event.type === "tool_call" || event.type === "overflow") {
                return Option.none<AgentEvent>();
              }
              if (event.type === "text") {
                answer += event.text;
              }
              return Option.some<AgentEvent>(event);
            }),
          );
          const afterAttempt = Stream.unwrap(
            Effect.sync(() => (answer.trim() === "" ? recoverEmptyAnswer(attempt) : Stream.empty)),
          );
          return Stream.concat(model, afterAttempt);
        });
      return Stream.concat(
        Stream.succeed<AgentEvent>({ type: "stop", stop }),
        Stream.concat(Stream.succeed<AgentEvent>({ type: "step_limit", steps: n }), attempt()),
      );
    });

  // The single mid-turn-switch re-resolution boundary (plan 09.1 D-001/D-002): the loop reads the
  // per-turn switch cell exactly here - at each step start, before the model stream opens - so a switch
  // requested while the prior step's stream was open lands on this step and never interrupts a request
  // in flight. Phase 1 applies a reasoning-only change to `currentReasoning`; later phases rebuild the
  // provider on a model delta and record the switch. Returns the applied request, or undefined.
  const applyPendingSwitch = (): SwitchRequest | undefined => {
    const req = opts.switch?.take();
    if (!req) {
      return undefined;
    }
    if (req.reasoning !== undefined) {
      currentReasoning = req.reasoning;
    }
    return req;
  };

  // Stream.suspend keeps each step lazy: its provider.stream (which reads `conversation`)
  // is constructed only when the stream actually reaches this step - after the prior
  // step's tools have run and threaded their results - never eagerly while building it.
  const step = (n: number): Stream.Stream<AgentEvent, ProviderError> =>
    Stream.suspend(() => {
      // Re-resolve model+reasoning from the switch cell before the budget gate, so a mid-turn switch
      // both drives this step's model stream and sizes its adaptive budget.
      applyPendingSwitch();
      // Budget gate before opening another tool round: the step backstop OR - the real
      // governor - the prior step's prompt crossing the configured fraction of the window.
      // Either way force a final answer rather than ending on a tool stub. At step 0 both are
      // clear (no prior usage), so the first round always runs.
      const { stop, checkpoint, budget, threshold: activeThreshold } = assessTurn(n);
      // Structured budget factors behind the verbose `agent` scope (D-026): a postmortem can tell a
      // healthy large-context budget exhaustion from an unknown-telemetry fallback via tier/telemetry,
      // and an auto-continued checkpoint from a ceiling/guard pause via grant + threshold + advance.
      debug("agent", "turn-budget", {
        step: n,
        effective: budget.effectiveMaxSteps,
        emergency: budget.emergencyMaxSteps,
        grantedSteps,
        activeThreshold,
        contextAdvanced: lastInputTokens - checkpointInputTokens,
        checkpoint,
        tier: budget.factors.contextTier,
        telemetry: budget.factors.telemetryQuality,
        pressure: budget.factors.pressure,
        contextWindow: budget.factors.contextWindow,
        repeatedRounds: budget.factors.repeatedToolRounds,
        repeatedPenalty: budget.factors.repeatedToolPenalty,
        reasoningPenalty: budget.factors.reasoningPenalty,
        providerKind: budget.factors.providerKind,
        reason: budget.reason,
      });
      if (stop?.action === "synthesized") {
        return synthesize(n, stop);
      }
      if (stop) {
        return Stream.concat(
          Stream.succeed<AgentEvent>({ type: "stop", stop }),
          Stream.succeed<AgentEvent>({ type: "step_limit", steps: n }),
        );
      }
      if (checkpoint) {
        // Auto-continue: grant one tier-base worth so the NEXT checkpoint is further out (discrete
        // checkpoints, D-005), snapshot context for the next progress-guard window, drop a quiet
        // breadcrumb, then RE-ENTER this step - the re-check now passes the raised threshold and runs
        // the model step. The emergency ceiling still terminates the step axis.
        grantedSteps += budget.factors.baseBudget;
        checkpointInputTokens = lastInputTokens;
        const pressure = budget.factors.pressure;
        // Recomputed AFTER the grant above, so it reflects the raised threshold the next checkpoint sees.
        const nextThreshold = thresholdFor(budget);
        return Stream.concat(
          Stream.succeed<AgentEvent>({
            type: "checkpoint",
            steps: n,
            pressure,
            threshold: nextThreshold,
            detail: `continued at step ${n} - ${(pressure * 100).toFixed(1)}% context, room left`,
          }),
          step(n),
        );
      }
      const toolCalls: ToolCall[] = [];
      let assistantText = "";
      let overflowReason: string | null = null;

      // The model step: forward the shared ModelEvent variants (text/thinking/usage)
      // straight through - they ARE AgentEvents - while siphoning off assistant text
      // (accumulated), tool calls (collected, into tool_start/tool_end below), and any
      // overflow (captured for recovery below - not surfaced here).
      //
      // Auto-reconnect (D-076…D-079): a transient provider outage that drops the stream BEFORE any
      // event arrives is retried with bounded backoff, emitting a `reconnecting` marker between
      // attempts. The `sawEvent` guard is load-bearing: a retry only happens when nothing streamed,
      // so the siphon closures (toolCalls/assistantText/overflowReason) are still clean and a retry
      // never double-counts. Once any event has streamed - or the error is non-retryable, or the
      // attempt budget is spent - the failure propagates and the turn goes terminal exactly as
      // before. Interrupts (ESC/cancel) ride the interrupt channel, not this typed `E` channel, so
      // catchAll never sees them: they are never retried and cancel stays instant during a backoff.
      const connectStep = (attempt: number): Stream.Stream<AgentEvent, ProviderError> => {
        let textChars = 0;
        let thinkingChars = 0;
        let toolCallsStarted = 0;
        const partials = (): ProviderPartialCounts => ({
          textChars,
          thinkingChars,
          toolCalls: toolCallsStarted,
          // This model stream is the pre-tool-execution step: it carries tool CALLS, never results.
          toolResults: 0,
        });
        const safeToRetry = () => textChars === 0 && toolCallsStarted === 0;
        const outputStarted = () => textChars > 0;
        const mapped = modelStream(tools, currentReasoning).pipe(
          Stream.filterMap((event) => {
            if (event.type === "text") {
              textChars += event.text.length;
            } else if (event.type === "thinking") {
              thinkingChars += event.text.length;
            } else if (event.type === "tool_call") {
              toolCallsStarted += 1;
            }
            if (event.type === "tool_call") {
              toolCalls.push(event.call);
              return Option.none<AgentEvent>();
            }
            if (event.type === "overflow") {
              // Capture; afterModel decides recover-and-retry vs terminal (D-035, D-038).
              overflowReason = event.reason;
              return Option.none<AgentEvent>();
            }
            if (event.type === "text") {
              assistantText += event.text;
            }
            if (event.type === "usage") {
              // Capture the prompt size + window for the next round's context-budget gate.
              lastInputTokens = event.usage.input;
              lastContextWindow = event.usage.contextWindow;
              // Baseline the progress guard at the FIRST observed prompt size (02.17): the first
              // checkpoint then measures growth DURING the turn, so a flat (no-context-growth) turn
              // pauses at the budget instead of getting a free auto-continue from the start-at-zero.
              if (!checkpointBaselined) {
                checkpointInputTokens = lastInputTokens;
                checkpointBaselined = true;
              }
            }
            // text/thinking/usage flow through unchanged (shared ModelEvent shapes).
            return Option.some<AgentEvent>(event);
          }),
        );
        return mapped.pipe(
          Stream.catchAll((error) => {
            const retryable = error._tag === "ProviderUnavailable" && error.retryable === true;
            const retrySafe = safeToRetry();
            if (retrySafe && retryable && attempt < config.reconnectBackoffsMs.length + 1) {
              const next = attempt + 1;
              const base = config.reconnectBackoffsMs[attempt - 1] ?? 0;
              const wait = base + Math.round(Math.random() * 150); // small jitter, no lockstep
              logProviderFailure(provider, error, next, "reconnect");
              const diagnostic = providerDiagnostic(provider, error, next, true, partials());
              return Stream.concat(
                Stream.succeed<AgentEvent>({
                  type: "reconnecting",
                  attempt: next,
                  maxAttempts: config.reconnectBackoffsMs.length + 1,
                  detail: error.detail,
                  diagnostic,
                }),
                Stream.unwrap(
                  Effect.sleep(Duration.millis(wait)).pipe(Effect.as(connectStep(next))),
                ),
              );
            }
            // Terminal: log the classified failure with its fingerprint (D-076 M6), then - for an
            // UNKNOWN shape only - record a redacted, deduped observation (D-076 M5) so the
            // classifier's rules can improve later. Best-effort and output-started-aware; never fails
            // the turn.
            logProviderFailure(provider, error, attempt, "terminal");
            const diagnostic = providerDiagnostic(provider, error, attempt, retrySafe, partials());
            const diagnosticError =
              error instanceof ProviderUnavailable ? error.withDiagnostic(diagnostic) : error;
            return Stream.concat(
              observeUnknownFailure(provider, diagnosticError, outputStarted()),
              Stream.fail(diagnosticError),
            );
          }),
        );
      };
      const modelStep = connectStep(1);

      // Built lazily (Stream.unwrap defers the thunk until the model step has drained), so
      // it reads the now-populated toolCalls/assistantText: run each tool in order, then
      // recurse to the next step. No tool calls means the model answered - stop.
      const afterModel = Stream.unwrap(
        Effect.sync(() => {
          // Overflow recovery: try one cheap in-loop adjustment and re-run the SAME step
          // (n unchanged, so recovery is independent of the step budget). Only when the budget
          // is spent does the terminal overflow surface (D-038).
          if (overflowReason !== null) {
            const recovered = tryRecover(overflowReason);
            if (recovered) {
              return Stream.concat(Stream.succeed(recovered), step(n));
            }
            return Stream.succeed<AgentEvent>({ type: "overflow", reason: overflowReason });
          }
          if (toolCalls.length === 0) {
            // The model answered. An answer with no text is a stall (it emitted only a stop token) -
            // recover through the shared empty-retry (splice to the current task + retry the step
            // once), then surface an `empty` event so the turn never ends silently (which is what
            // poisons the next turn's history).
            if (assistantText.trim() === "") {
              return recoverEmptyAnswer(() => step(n));
            }
            const protocolDiagnostic = classifyProviderProtocolAnomaly({
              providerId: provider.id,
              text: assistantText,
              toolCalls,
            });
            if (protocolDiagnostic) {
              // Nudge once when tools are still offered and no unsafe boundary crossed: this step
              // produced no typed tool call (toolCalls is empty), so re-running only re-asks the
              // model - any prior tool results stay committed in `conversation`, so the nudge
              // repeats no side effect. The nudge (assistant echo + instruction) is conversation-only,
              // never emitted or persisted; the retry's output streams as ordinary text below it.
              if (useTools && !protocolNudged) {
                protocolNudged = true;
                conversation.push({ role: "assistant", content: assistantText });
                conversation.push({
                  role: "user",
                  content:
                    "Your previous message contained raw tool-call protocol markup as text instead " +
                    "of an actual tool call. Use the typed tool-calling interface to call a tool, or " +
                    "answer in plain text with no tool-call tags or JSON.",
                });
                return step(n);
              }
              // Persistent anomaly (already nudged) or a tool-less turn: terminate with the typed
              // incident so the web renders the leaked markup escaped and /doctor can correlate it.
              const { stop } = assessTurn(n, protocolDiagnostic);
              const diagnostic = protocolAnomalyDiagnostic(provider, protocolDiagnostic, {
                textChars: assistantText.length,
                thinkingChars: 0,
                toolCalls: 0,
                toolResults: 0,
              });
              if (!stop) {
                return Stream.empty;
              }
              return Stream.succeed<AgentEvent>({ type: "stop", stop, diagnostic });
            }
            // Non-empty text, no tool call. Normally this IS the final answer - but if the text
            // trails off announcing more work it never did, nudge it once to carry it out. If it
            // still answers without tools after the nudge, accept it (bounded, can't loop).
            if (!continueRetried && looksUnfinished(assistantText)) {
              continueRetried = true;
              conversation.push({ role: "assistant", content: assistantText });
              conversation.push({
                role: "user",
                content:
                  "You ended by describing work without doing it. Call the tools to carry out what you just described now, or give your final answer - do not announce actions you do not take.",
              });
              return step(n);
            }
            return Stream.empty;
          }
          conversation.push({
            role: "assistant",
            content: assistantText,
            toolCalls: [...toolCalls],
          });
          const toolCall = toolCalls.length === 1 ? toolCalls[0] : undefined;
          const toolName = toolCall?.name;
          const toolSignature = toolCall ? `${toolCall.name}:${toolCall.arguments}` : undefined;
          if (toolSignature && toolSignature === repeatedToolSignature) {
            repeatedToolRounds += 1;
          } else {
            repeatedToolName = toolName;
            repeatedToolSignature = toolSignature;
            repeatedToolRounds = toolName ? 1 : 0;
          }
          // Each call writes its result into an index-keyed slot instead of pushing to
          // `conversation` on completion: concurrent read children finish in any order, but
          // the slots commit to history deterministically in CALL order after the batch drains
          // (so recovery + the next step always see one canonical, call-ordered conversation).
          const slots: string[] = new Array(toolCalls.length);

          // One call's execution as a Stream: run the tool, store its result in the slot, emit
          // tool_end. tool_start is emitted separately (hoisted ahead of the merge, in call
          // order) so the transcript shows every read card in call order even though the
          // executes overlap; only the result-bearing tool_end rides out in completion order,
          // which the web tolerates by keying results on call.id (D-050 / M4).
          const execute = (
            call: ToolCall,
            index: number,
          ): Stream.Stream<AgentEvent, ProviderError> =>
            Stream.unwrap(
              runTool(call.name, call.arguments, call.id).pipe(
                Effect.map((rawResult): Stream.Stream<AgentEvent, ProviderError> => {
                  // Observe the completed call (07): the controller fingerprints the args + result and
                  // returns a redacted decision. A `warn` appends guidance to the model-facing result;
                  // execution is never suppressed (D-003), so the model still gets the tool output.
                  const decision = guardrails.observe(call.name, call.arguments, rawResult);
                  const result = guardedToolResult(rawResult, decision);
                  slots[index] = result;
                  const events: AgentEvent[] = [{ type: "tool_end", call, result }];
                  // A non-allow decision rides out as a redacted guardrail event (turn.ts publishes
                  // tool.guardrail); the model-facing guidance stays on the tool result above.
                  if (decision.action !== "allow") {
                    events.push({ type: "guardrail", call, decision });
                  }
                  return Stream.fromIterable(events);
                }),
              ),
            );

          // Partition into ordered segments (maximal read-only runs vs single mutating barriers)
          // and run them back-to-back. Within a read run the executes merge, bounded by
          // configured tool concurrency; a barrier is a one-element merge, so it runs alone. Because the
          // segments are concatenated, a mutating call never overlaps the reads around it - two
          // edits to one path apply in call order with no lost update (D-050 / M3).
          const batch = partitionToolCalls(toolCalls).reduce(
            (acc, segment) => {
              const starts = Stream.fromIterable(
                segment.map(({ call }): AgentEvent => ({ type: "tool_start", call })),
              );
              const executes = Stream.mergeAll(
                segment.map(({ call, index }) => execute(call, index)),
                { concurrency: config.toolConcurrency },
              );
              return Stream.concat(acc, Stream.concat(starts, executes));
            },
            Stream.empty as Stream.Stream<AgentEvent, ProviderError>,
          );

          // Commit the slots to `conversation` in CALL order once the whole batch has drained,
          // then open the next step - so step(n+1) reads a fully-committed, deterministically
          // ordered conversation regardless of which reads finished first.
          const commit = Stream.unwrap(
            Effect.sync(() => {
              toolCalls.forEach((call, i) => {
                conversation.push({
                  role: "tool",
                  content: slots[i] ?? "",
                  toolCallId: call.id,
                  name: call.name,
                });
              });
              return step(n + 1);
            }),
          );
          return Stream.concat(batch, commit);
        }),
      );

      return Stream.concat(modelStep, afterModel);
    });

  return step(0);
}
