/**
 * Responsible for: the model<->tools agent loop composition for one turn (runAgent) - stepping
 * the provider stream, running tool calls, and applying budgets, guardrails, watchdogs, and
 * mid-turn switches.
 * Not for: publishing the turn as session events - publishTurn (turn.ts).
 */
import { debug } from "@host/transport/log";
import {
  constrainReasoning,
  type ModelRef,
  type ProviderDiagnostic,
  type ProviderPartialCounts,
  sameModel,
  type TurnStop,
} from "@trevor/session";
import { NOOP_SINK, SPAN_NAMES, type TelemetrySink } from "@trevor/session/telemetry";
import { Duration, Effect, Option, Stream } from "effect";
import type {
  ChatMessage,
  ModelEvent,
  Provider,
  ProviderError,
  ProviderEvent,
  ToolCall,
  ToolDef,
} from "../providers";
import { ProviderUnavailable, protocolAnomalyDiagnostic, providerDiagnostic } from "../providers";
import {
  classifyProviderProtocolAnomaly,
  type ProviderProtocolDiagnostic,
} from "../providers/protocol-anomaly";
import { spanEffect } from "../telemetry/span";
import { executeTool, offeredToolDefs, READ_ONLY_TOOLS } from "../tools";
import { fitsAfterSwitch } from "./context-guard";
import { normalizeConversationForProvider } from "./cross-model";
import { type TurnLoopConfig, turnLoopConfig } from "./loop-config";
import { logProviderFailure, observeUnknownFailure } from "./loop-failures";
import { withStallTimeout, withToolStallTimeout } from "./loop-stalls";
import { guardedToolResult, looksUnfinished, partitionToolCalls } from "./loop-tool-calls";
import { trimLargestToolResult } from "./overflow-recovery";
import { cheapestReasoning, reduceReasoning } from "./reasoning-levels";
import type { SwitchCell, SwitchEndpoint, SwitchInitiator } from "./switch-cell";
import {
  createToolGuardrails,
  type GuardrailConfig,
  type GuardrailDecision,
} from "./tool-guardrails";
import { deriveTurnBudget, type TurnBudget } from "./turn-budget";
import { TurnTerminationGate } from "./turn-policy";

/** The progress guard threshold (02.17 D-003): a step-budget checkpoint auto-continues only if the
 *  prompt grew by at least this many tokens since the previous checkpoint. Tiny relative to a real
 *  work window (thousands of tokens of tool results), so genuine work always clears it; a diverse-no-op
 *  loop that the same-tool stall detector misses adds ~0 and trips it, pausing instead of running to
 *  the emergency ceiling. */
const CHECKPOINT_MIN_ADVANCE_TOKENS = 1_024;

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
  | {
      /** A mid-turn model/reasoning switch resolved at this step boundary (09.1): applied, or blocked by
       *  the larger->smaller context guard. Carries the from/to model+reasoning, who asked, and the
       *  outcome. turn.ts maps it to the durable `model.switched` session event, which the web folds into
       *  the transcript marker. */
      readonly type: "model_switched";
      readonly from: SwitchEndpoint;
      readonly to: SwitchEndpoint;
      readonly initiator: SwitchInitiator;
      readonly outcome: "applied" | "blocked";
      readonly reason?: string;
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
  /** Rebuilds the active provider for a mid-turn MODEL change (09.1 M4): resolves a target `ModelRef` to
   *  a fresh `Provider` (the host wires `buildSourceProvider`), since `Provider.model` is readonly.
   *  Returns null when the target is unresolvable, in which case the switch leaves the provider unchanged.
   *  Absent means model changes are not honored (reasoning-only), as in Phase 1. */
  readonly rebuildProvider?: (model: ModelRef) => Provider | null;
  /** The turn's starting `ModelRef` (09.1 M4): the identity (`sourceId`+`modelId`) a mid-turn switch
   *  compares against to decide whether the model actually changed - `Provider` only carries a model id,
   *  not its source, so two sources serving the same id would otherwise be indistinguishable. Absent on a
   *  turn with no resolved ref (the first switch then always rebuilds). */
  readonly initialModel?: ModelRef;
  /** The telemetry sink for per-tool spans (plan 13 M3); NOOP (disabled) unless the host wires an
   *  exporter. Tool spans carry the tool name + ok/error/interrupted status, never args or output. */
  readonly telemetry?: TelemetrySink;
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
  const sink = opts.telemetry ?? NOOP_SINK;
  const executeOne =
    opts.runTool ??
    ((name: string, args: string, callId: string): Effect.Effect<string> =>
      withToolStallTimeout(name, executeTool(name, args, runId, callId), config.toolStallMs));
  const runTool = (name: string, args: string, callId: string): Effect.Effect<string> => {
    // A delegation tool-call is routed to the injected runner (it has the provider + transport the
    // generic executor lacks); everything else goes to the executor, gated by the allow-list. `callId`
    // is forwarded so a tool that needs the active tool-call id (ask_user) can correlate its UI events.
    // Each execution is wrapped in a `trevor.tool` span (tool name + status only, never args/output).
    const execute = (): Effect.Effect<string> => {
      if (delegate?.names.has(name)) {
        return Effect.promise(() => delegate.run(name, args));
      }
      if (opts.toolNames && !opts.toolNames.has(name)) {
        return Effect.succeed(`error: tool "${name}" is not available to this agent`);
      }
      return executeOne(name, args, callId);
    };
    return execute().pipe(spanEffect(sink, SPAN_NAMES.tool, { tool: name }));
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
  // The active provider for this turn (plan 09.1 M4): seeded from the argument and REBUILT in place when a
  // mid-turn switch changes the model (Provider.model is readonly). Every model step, budget derivation,
  // and failure log below reads `currentProvider`, so the swap takes effect at the next step boundary.
  let currentProvider = provider;
  // The active model's identity (source+id), tracked so a mid-turn switch can tell a real model change
  // from the UI re-sending the unchanged model on a reasoning-only switch (M4). Undefined until the turn
  // carries a resolved ref; the first switch then rebuilds unconditionally.
  let currentRef = opts.initialModel;
  // How many mid-turn switches this turn has applied or blocked (09.1 M8), surfaced in the switch trace.
  let switchCount = 0;

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
      providerId: currentProvider.id,
      providerKind: currentProvider.kind,
      model: currentProvider.model,
      reasoning: currentReasoning,
      reasoningLevels: currentProvider.reasoningLevels,
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
      : reduceReasoning(currentProvider.reasoningLevels, currentReasoning);
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
      currentProvider.stream(conversation, stepTools, reasoning),
      currentProvider.model,
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
      const synthReasoning = cheapestReasoning(currentProvider.reasoningLevels);
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

  const endpoint = (): SwitchEndpoint => ({
    model: currentProvider.model,
    ...(currentReasoning !== undefined ? { reasoning: currentReasoning } : {}),
  });

  // The provider-rebuild path for a model change (plan 09.1 M4), kept separate from cell-read so the
  // cross-provider normalization phase (M6) extends only here. Rebuilds `currentProvider` from the target
  // ModelRef when the model id actually changes (Provider.model is readonly); a failed/absent resolver
  // leaves the active provider unchanged. The carried `conversation` array is untouched, so history
  // continuity across a same-provider swap is automatic.
  const rebuildForModelSwitch = (model: ModelRef): void => {
    // Skip the rebuild only when the target is the SAME model (source + id) - the UI re-sends the
    // unchanged model on a reasoning-only switch. Comparing source too is load-bearing: two sources can
    // serve the same model id, and a Provider only carries the id, so a model-id-only check would keep
    // the wrong source. With no known current ref (turn carried none), rebuild to be safe.
    if (currentRef && sameModel(currentRef, model)) {
      return;
    }
    const rebuilt = opts.rebuildProvider?.(model);
    if (!rebuilt) {
      return;
    }
    // A cross-PROVIDER swap (different source) carries provider A's encodings onto provider B, which can
    // reject them, so normalize the conversation in place before B replays it (M6). A same-provider model
    // swap keeps the encodings, so the carried array is untouched (intra-provider continuity, M4).
    if (rebuilt.id !== currentProvider.id) {
      const normalized = normalizeConversationForProvider(conversation);
      conversation.splice(0, conversation.length, ...normalized);
    }
    currentProvider = rebuilt;
    currentRef = model;
  };

  // Structured switch observability behind the `agent` debug scope (plan 09.1 M8): every applied/blocked
  // switch logs from/to model+reasoning, who asked, the running per-turn count, and the guard's context-fit
  // numbers, so /doctor (which reads this scope) can postmortem a turn's model changes. The durable
  // `model.switched` event + the transcript marker are the user-visible surfaces; this is the trace.
  const observeSwitch = (
    event: Extract<AgentEvent, { type: "model_switched" }>,
    targetWindow: number | undefined,
  ): void => {
    debug("agent", "model-switch", {
      from: `${event.from.model}/${event.from.reasoning ?? "-"}`,
      to: `${event.to.model}/${event.to.reasoning ?? "-"}`,
      initiator: event.initiator,
      outcome: event.outcome,
      switchCount,
      conversationTokens: lastInputTokens,
      currentWindow: lastContextWindow,
      targetWindow: targetWindow ?? 0,
    });
  };

  // The single mid-turn-switch re-resolution boundary (plan 09.1 D-001/D-002): the loop reads the per-turn
  // switch cell exactly once per step, right before the model stream opens (below), so a switch requested
  // while the prior step's stream was open lands on this step and never interrupts a request in flight, and
  // is preserved across a stop/checkpoint that does not open a model step. A model delta rebuilds the
  // provider; reasoning is then clamped to the (possibly new) provider's surface so a level the target
  // lacks carries to the nearest supported one. Returns the `model_switched` loop event to emit ahead of
  // the step (applied or blocked), or undefined when none was queued. This is the seam the future
  // auto-router attaches to (D-004).
  const applyPendingSwitch = (): Extract<AgentEvent, { type: "model_switched" }> | undefined => {
    const req = opts.switch?.take();
    if (!req) {
      return undefined;
    }
    switchCount += 1;
    const from = endpoint();
    // Larger->smaller context guard (M7, D-007): refuse a model switch whose target window cannot hold the
    // conversation - leave the active provider + reasoning untouched and record the refusal so the marker
    // shows why nothing changed. smaller->larger and unknown targets pass through.
    if (req.model && req.targetWindow !== undefined) {
      const fit = fitsAfterSwitch({
        conversationTokens: lastInputTokens,
        currentWindow: lastContextWindow,
        targetWindow: req.targetWindow,
      });
      if (!fit.fits) {
        const blocked: Extract<AgentEvent, { type: "model_switched" }> = {
          type: "model_switched",
          from,
          to: from,
          initiator: req.initiator,
          outcome: "blocked",
          ...(fit.reason ? { reason: fit.reason } : {}),
        };
        observeSwitch(blocked, req.targetWindow);
        return blocked;
      }
    }
    if (req.model) {
      rebuildForModelSwitch(req.model);
    }
    // Re-clamp reasoning to the (possibly new) provider's surface. Skip when the request names neither a
    // model nor a level - there is nothing to carry, and clamping a null request would push an
    // undefined-reasoning turn onto the provider default rather than leaving it as-is.
    const requested = req.reasoning ?? req.model?.reasoning ?? currentReasoning ?? null;
    if (requested !== null || req.model) {
      currentReasoning =
        constrainReasoning(
          { levels: currentProvider.reasoningLevels, default: currentProvider.defaultReasoning },
          requested,
        ) ?? undefined;
    }
    const applied: Extract<AgentEvent, { type: "model_switched" }> = {
      type: "model_switched",
      from,
      to: endpoint(),
      initiator: req.initiator,
      outcome: "applied",
    };
    observeSwitch(applied, req.targetWindow);
    return applied;
  };

  // Stream.suspend keeps each step lazy: its provider.stream (which reads `conversation`)
  // is constructed only when the stream actually reaches this step - after the prior
  // step's tools have run and threaded their results - never eagerly while building it.
  const step = (n: number): Stream.Stream<AgentEvent, ProviderError> =>
    Stream.suspend(() => {
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
              logProviderFailure(currentProvider, error, next, "reconnect");
              const diagnostic = providerDiagnostic(currentProvider, error, next, true, partials());
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
            logProviderFailure(currentProvider, error, attempt, "terminal");
            const diagnostic = providerDiagnostic(
              currentProvider,
              error,
              attempt,
              retrySafe,
              partials(),
            );
            const diagnosticError =
              error instanceof ProviderUnavailable ? error.withDiagnostic(diagnostic) : error;
            return Stream.concat(
              observeUnknownFailure(currentProvider, diagnosticError, outputStarted()),
              Stream.fail(diagnosticError),
            );
          }),
        );
      };
      // Apply a pending mid-turn switch now that this step is committed to a model call (past the
      // stop/checkpoint gates): re-read model+reasoning, then emit the `model_switched` marker ahead of
      // the step that runs under it. A switch landing on a stopped/checkpointed step stays queued for the
      // next real step instead of being silently consumed.
      const switched = applyPendingSwitch();
      const modelStep = switched
        ? Stream.concat(Stream.succeed<AgentEvent>(switched), connectStep(1))
        : connectStep(1);

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
              providerId: currentProvider.id,
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
              const diagnostic = protocolAnomalyDiagnostic(currentProvider, protocolDiagnostic, {
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
