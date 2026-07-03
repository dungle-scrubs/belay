import type { AdmissionPriority } from "@host/admission/contract";
import {
  AdmissionTurnRef,
  type AdmissionTurnReporter,
  admissionStatusEvent,
} from "@host/admission/turn-ref";
import type { StopContext } from "@host/hooks/runtime";
import { BreakdownAccumulator, logUsageBreakdown } from "@host/metrics/breakdown";
import {
  type ChatMessage,
  type Provider,
  ProviderUnavailable,
  type Usage,
} from "@host/providers/index";
import { buildSystemPrompt, promptOverheadChars } from "@host/providers/system-prompt";
import { spanEffect } from "@host/telemetry/span";
import { offeredToolDefs } from "@host/tools/index";
import { MAX_OUTPUT } from "@host/tools/shared";
import { DeltaBuffer } from "@host/transport/delta-buffer";
import { warn } from "@host/transport/log";
import { Emit } from "@host/transport/services";
import {
  events,
  type ModelRef,
  type ProviderDiagnostic,
  type TrevorEventInput,
  type TurnStop,
} from "@trevor/session";
import {
  METRIC_NAMES,
  NOOP_SINK,
  recordMetric,
  SPAN_NAMES,
  type TelemetrySink,
} from "@trevor/session/telemetry";
import type { ProviderTraceWriter } from "@trevor/session/telemetry-provider-trace";
import { Cause, Effect, Exit, Fiber, FiberRef, Option, Stream } from "effect";
import { interpretFiberExit } from "../effect/fiber-exit";
import { withHookDecisionEvents } from "./hook-events";
import type { HistoryImageResolver } from "./image-resolution";
import { type AgentEvent, type DelegateCapability, runAgent, type TurnHooks } from "./loop";
import { type TurnLoopConfig, turnLoopConfig } from "./loop-config";
import { recordProviderIncident, recordTerminalProviderFailure } from "./loop-failures";
import { withStallTimeout } from "./loop-stalls";
import {
  continuationMessages,
  createStopToolSummary,
  stopHookHaltStop,
  stopTerminalReason,
  withContinuationExhausted,
} from "./stop-hook";
import type { SwitchCell } from "./switch-cell";
import { prepareTurn } from "./turn-preflight";
import { recordTurnStop } from "./turn-stop-metrics";

/**
 * Runs the agent loop for one turn as an Effect and publishes its lifecycle through the
 * Emit service: assistant.started, buffered delta/thinking, tool.started/completed,
 * overflow, and a terminal assistant.completed. The completion is emitted exactly once
 * from an uninterruptible onExit, so the three exits each get the right terminal event:
 * normal end -> {}, a fiber interrupt (cancel) -> {cancelled}, a provider failure ->
 * {error}. Owns the buffering and the AgentEvent -> event mapping so the host's connect
 * path stays about transport, not turn bookkeeping.
 *
 * Responsible for: publishing one turn's provider stream as session events.
 * Not for: the model<->tools loop composition - runAgent (loop.ts).
 */
export function publishTurn(
  provider: Provider,
  turnHistory: readonly ChatMessage[],
  options: {
    readonly runId: string;
    readonly reasoning?: string;
    /** A subagent's tool allow-list: restricts what the turn offers + runs (D-046). Absent = all. */
    readonly toolNames?: ReadonlySet<string>;
    /** The delegation capability for a PARENT turn (D-048); absent on a child turn (depth-1). */
    readonly delegate?: DelegateCapability;
    /** The PreToolUse hook capability (plan 25 M5): the host binds the hooks runtime plus this
     *  turn's session/caller identity so hooks gate every tool call. Absent = no hooks fire. */
    readonly hooks?: TurnHooks;
    readonly resolveImages?: HistoryImageResolver;
    /** Optional turn-loop config overrides (e.g. a small `emergencyMaxSteps` for tests); the loop
     *  fills the rest from `DEFAULT_TURN_LOOP_CONFIG`. Absent in production. */
    readonly loop?: Partial<TurnLoopConfig>;
    /** Carry-forward of the prior turn's measured usage (03.1 D-002), so the context-pressure gate
     *  can fire at step 0 when the turn inherits >= the fraction. Absent on a session's first turn. */
    readonly seedUsage?: { readonly input: number; readonly contextWindow: number };
    /** The per-turn mid-turn-switch cell (09.1): the host writes a switch request into it when a
     *  `model.switch.requested` control event lands; the loop reads it at the next step boundary. Absent
     *  on a subagent turn (not switchable). */
    readonly switch?: SwitchCell;
    /** Rebuilds the provider for a mid-turn MODEL change (09.1 M4): the host wires `buildSourceProvider`
     *  so the loop can swap to a target model. Absent on a turn that only supports reasoning switches. */
    readonly rebuildProvider?: (model: ModelRef) => Provider | null;
    /** The turn's starting model ref (09.1 M4): the identity a mid-turn switch compares against to tell a
     *  real model change from a reasoning-only re-send. Absent when the turn carried no resolved ref. */
    readonly initialModel?: ModelRef;
    /** The local-admission priority class for this turn (plan 11): foreground for a user turn (default),
     *  background for a subagent so it queues behind foreground local-model work. */
    readonly priority?: AdmissionPriority;
    /** The telemetry sink for the turn span + per-tool spans (plan 13 M3); NOOP (disabled) unless the
     *  host wires an exporter. Spans carry provider/model + status only, never prompt or tool content. */
    readonly telemetry?: TelemetrySink;
    /** The opt-in provider-attempt trace writer (plan 13 M6); absent = tracing disabled. Records a bounded,
     *  redacted record on a terminal provider failure (the deep debugging evidence for a flaky provider). */
    readonly providerTrace?: ProviderTraceWriter;
  },
): Effect.Effect<void, never, Emit> {
  const { runId, reasoning, toolNames, delegate, resolveImages, loop, seedUsage } = options;
  // The M9 hook.decision seam: wrap the turn's hooks ONCE so every PreToolUse/Stop dispatch
  // outcome also folds into visible hook.decision events. The wrapper only QUEUES them (its
  // observer callbacks are sync); the turn drains the queue through the same awaited Emit path
  // as every other event - deterministic ordering, never a dangling forked publish.
  const pendingHookEvents: TrevorEventInput[] = [];
  const turnHooks = options.hooks
    ? withHookDecisionEvents(options.hooks, options.runId, (event) => pendingHookEvents.push(event))
    : undefined;
  const switchCell = options.switch;
  const rebuildProvider = options.rebuildProvider;
  const initialModel = options.initialModel;
  const sink = options.telemetry ?? NOOP_SINK;
  const traceWriter = options.providerTrace;

  return Effect.gen(function* () {
    const emit = yield* Emit;

    // Carry the per-turn admission reporter on the fiber (plan 11 M7): the local provider reads it when
    // it acquires a generation lease, so a queued turn emits "waiting for LM Studio" attributed to this
    // run. Fire-and-forget emit (advisory status), so admission never blocks the turn loop.
    const admissionReporter: AdmissionTurnReporter = {
      context: { priority: options.priority ?? "foreground", runId },
      onStatus: (status) => {
        Effect.runFork(emit.publish(admissionStatusEvent(runId, status)));
      },
    };
    yield* FiberRef.set(AdmissionTurnRef, admissionReporter);

    const preflight = yield* prepareTurn(provider, turnHistory, { resolveImages });
    if (preflight.type === "blocked") {
      yield* emit.publish(
        events.assistantStarted({
          runId,
          warm: preflight.warm,
          model: provider.model,
          provider: provider.id,
        }),
      );
      yield* emit.publish(
        events.assistantCompleted({
          runId,
          text: "",
          error: preflight.error,
        }),
      );
      return;
    }
    const { warm, history, useTools } = preflight;

    // Token-source breakdown ("where does the context go?"). Fixed overhead = the
    // system prompt + the tool schemas the provider re-sends every step; the rest
    // is seeded from history and grows as the turn's tool results stream in.
    // A subagent only sees its allow-listed tools, so its overhead (system prompt + tool schemas)
    // is sized from that restricted set, matching what the model is actually offered; a parent's
    // overhead also covers the delegation tools it can call.
    const toolDefs = offeredToolDefs(useTools, toolNames, delegate?.defs);
    const breakdown = new BreakdownAccumulator(
      promptOverheadChars(buildSystemPrompt(toolDefs), toolDefs),
    );
    breakdown.seedHistory(history);

    yield* emit.publish(
      events.assistantStarted({
        runId,
        warm,
        model: provider.model,
        provider: provider.id,
      }),
    );

    let full = "";
    let usage: Usage | undefined;
    // Set when the loop reports the model ended the turn with no reply (after its one
    // retry): the terminal completion carries it so the UI shows a notice, not silence.
    let noReply = false;
    // Steps run when the turn hit its budget (step backstop or context gate). >0 flags the
    // completion as budget-terminated (a forced final answer follows) - distinct from a clean
    // answer, so the UI can show "stopped after N steps" (D-051).
    let stepLimitSteps = 0;
    let stop: TurnStop | undefined;
    // The structured incident from a NON-error terminal stop (a malformed-protocol anomaly, D-005):
    // it rides onto the success-path completion alongside `stop`. The error path carries its own
    // diagnostic through `extra` (from the typed ProviderError), which overrides this.
    let diagnostic: ProviderDiagnostic | undefined;
    // How many auto-reconnect attempts the loop emitted this turn (D-076 M6): if the turn still
    // ends in a provider failure, a nonzero count means the bounded retry budget was EXHAUSTED (a
    // transient outage that gave up) - distinct from a non-retryable terminal failure, which never
    // reconnects. The /doctor surface reads the two categories separately.
    let reconnectAttempts = 0;
    // The compact per-tool accounting for the Stop hook payload (plan 25 M7, D-004): every
    // EXECUTED tool completion this turn publishes is recorded (name + touched path when
    // cheaply derivable) - a hook-denied or halt-skipped call is not "what the turn ran", so it
    // never counts (25 simplify C4). Recording is skipped entirely when no Stop hook exists
    // (25 simplify E1); the whole Stop gate below is inert then too, so nothing reads it.
    const stopGateActive =
      turnHooks?.dispatchStop !== undefined && (turnHooks.hasHooks?.("Stop") ?? true);
    const toolSummary = createStopToolSummary();

    const text = new DeltaBuffer((delta) =>
      emit.publish(events.assistantDelta({ runId, text: delta })),
    );

    // Reasoning text rides its own event channel so the browser can show or hide it.
    const thinking = new DeltaBuffer((delta) =>
      emit.publish(events.assistantThinking({ runId, text: delta })),
    );

    const flushAll = Effect.gen(function* () {
      yield* text.flush();
      yield* thinking.flush();
    });

    // Drains the hook.decision events the wrapped hooks queued (M9): called at each loop-event
    // boundary and after the Stop gate, so every queued event publishes through the same
    // awaited Emit path - and always AHEAD of the terminal completion.
    const flushHookEvents = Effect.gen(function* () {
      while (pendingHookEvents.length > 0) {
        const next = pendingHookEvents.shift();
        if (next) {
          yield* emit.publish(next);
        }
      }
    });

    const complete = (extra: {
      error?: string;
      cancelled?: boolean;
      diagnostic?: ProviderDiagnostic;
    }) =>
      emit.publish(
        events.assistantCompleted({
          runId,
          text: full,
          usage,
          breakdown: breakdown.snapshot(),
          ...(noReply ? { noReply: true } : {}),
          ...(stepLimitSteps > 0 ? { stepLimit: stepLimitSteps } : {}),
          ...(stop ? { stop } : {}),
          ...(diagnostic ? { diagnostic } : {}),
          ...extra,
        }),
      );

    // The ONE continuation pass a Stop context can buy (plan 25 M8, D-004): a tool-less
    // synthesis step inside this same run - the turn's history, the answer being continued, and
    // the hooks' attributed notes as one user message. Its text streams as ordinary deltas onto
    // this completion (no new event kinds), tool_call/overflow events are DROPPED (zero tools
    // offered - model-context-only, structurally unable to mutate), and the same stall watchdog
    // as a loop step bounds it. A pass failure is a warn, never a wedge - the turn finalizes
    // with what it already has. Uses the turn's ORIGINAL provider (a mid-turn switch's rebuilt
    // provider is loop-internal), which is the model that produced the answer being continued.
    const continuationPass = (contexts: readonly StopContext[]): Effect.Effect<void> =>
      Effect.gen(function* () {
        const messages = continuationMessages(turnHistory, full, contexts);
        const lead = full.length > 0 ? "\n\n" : "";
        let emitted = false;
        yield* Stream.runForEach(
          withStallTimeout(
            provider.stream(messages, [], reasoning),
            provider.model,
            turnLoopConfig(loop).streamStallMs,
          ),
          (event) =>
            Effect.gen(function* () {
              if (event.type === "text") {
                // The pass reads as a new paragraph under the answer it continues.
                const piece = emitted ? event.text : `${lead}${event.text}`;
                emitted = true;
                full += piece;
                breakdown.onAnswer(piece.length);
                yield* text.add(piece);
              } else if (event.type === "thinking") {
                breakdown.onThinking(event.text.length);
                yield* thinking.add(event.text);
              } else if (event.type === "usage") {
                usage = {
                  input: event.usage.input,
                  output: (usage?.output ?? 0) + event.usage.output,
                  contextWindow: event.usage.contextWindow,
                  genMs: (usage?.genMs ?? 0) + event.usage.genMs,
                };
              }
              // tool_call/overflow are dropped: the pass offers ZERO tools (D-004).
            }),
        ).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() =>
              warn("hooks", "stop continuation pass failed", {
                run: runId.slice(0, 8),
                error: error.message,
              }),
            ),
          ),
        );
        yield* flushAll;
      });

    // The Stop finalization gate (plan 25 M7/M8, D-004): runs every approved+enabled Stop hook
    // over the FINAL text + terminal reason BEFORE the completed event publishes (the emission
    // awaits the dispatch, bounded by the per-hook timeouts). A halt swaps the completion's stop
    // for the visible hook-halt marker - the completion still publishes, so the turn ENDS (halt
    // blocks "finalize as-is" semantics, never the run's termination). A context (continuation
    // request) buys AT MOST one synthesis pass, then Stop re-dispatches so hooks review the TRUE
    // final text: a halt there is honored, a second context is ignored with a diagnostic. The
    // budget is a per-run local - one run IS one turn here, so a new user turn resets it.
    // Dispatched ONLY from the success exit below: a genuine terminal assistant result. A
    // cancelled/interrupted fiber, a provider failure, and a preflight-blocked turn never
    // dispatch Stop. `onStopOutcome` is the M9 seam and observes EVERY dispatch's outcome.
    const stopHookGate = Effect.gen(function* () {
      const dispatchStop = turnHooks?.dispatchStop;
      if (!turnHooks || !dispatchStop || !stopGateActive) {
        return;
      }
      let continuationUsed = false;
      // Bounded structurally: iteration 1 returns or spends the budget; iteration 2 always returns.
      while (true) {
        const outcome = yield* Effect.promise(() =>
          dispatchStop({
            event: "Stop",
            sessionId: turnHooks.identity.sessionId,
            runId,
            turnId: runId,
            cwd: turnHooks.identity.cwd,
            terminalReason: stopTerminalReason(stop),
            finalText: full,
            toolSummary: toolSummary.snapshot(),
          }),
        );
        if (outcome.decision === "halt") {
          turnHooks.observers?.onStopOutcome?.({ outcome });
          stop = stopHookHaltStop(outcome);
          return;
        }
        if (outcome.contexts.length === 0) {
          turnHooks.observers?.onStopOutcome?.({ outcome });
          return;
        }
        if (continuationUsed) {
          // The second continuation request (D-004): ignored, diagnosed, observable.
          turnHooks.observers?.onStopOutcome?.({ outcome: withContinuationExhausted(outcome) });
          warn("hooks", "stop continuation ignored", {
            run: runId.slice(0, 8),
            hook: outcome.contexts[0]?.hook,
          });
          return;
        }
        continuationUsed = true;
        turnHooks.observers?.onStopOutcome?.({ outcome });
        // Forked as its own INTERRUPTIBLE daemon fiber: this gate runs inside the turn's
        // uninterruptible onExit, where running the pass in place would wedge - the stall
        // watchdog's scoped fiber would inherit uninterruptibility and the stream's scope close
        // would await it forever. The daemon self-bounds (watchdog + a finite provider stream),
        // so this await is bounded; the pass never fails (it folds stream errors into a warn).
        const pass = yield* Effect.forkDaemon(
          Effect.interruptible(continuationPass(outcome.contexts)),
        );
        const passExit = yield* Fiber.await(pass);
        if (Exit.isFailure(passExit)) {
          warn("hooks", "stop continuation pass died", { run: runId.slice(0, 8) });
        }
      }
    });

    const handle = (event: AgentEvent) =>
      Effect.gen(function* () {
        // Hook decisions queued during the previous execution window publish first (M9), so a
        // deny/context row lands ahead of the tool.completed it explains.
        yield* flushHookEvents;
        if (event.type === "text") {
          full += event.text;
          breakdown.onAnswer(event.text.length);
          yield* text.add(event.text);
        } else if (event.type === "thinking") {
          breakdown.onThinking(event.text.length);
          yield* thinking.add(event.text);
        } else if (event.type === "tool_start") {
          breakdown.onToolCall(event.call.arguments.length);
          yield* flushAll;
          yield* emit.publish(
            events.toolStarted({
              runId,
              callId: event.call.id,
              name: event.call.name,
              arguments: event.call.arguments,
            }),
          );
        } else if (event.type === "tool_end") {
          breakdown.onToolResult(event.call.name, event.result.length);
          // Stop-payload accounting records EXECUTED completions only (25 simplify C4): a
          // denied/skipped call carries `skipped`, and an unhooked turn records nothing (E1).
          if (stopGateActive && !event.skipped) {
            toolSummary.record(event.call.name, event.call.arguments);
          }
          yield* emit.publish(
            events.toolCompleted({
              runId,
              callId: event.call.id,
              name: event.call.name,
              // Align the event-result cap with the tool-level output cap so a tool's
              // full result (e.g. web_search JSON) reaches the model and web intact.
              result: event.result.slice(0, MAX_OUTPUT),
            }),
          );
        } else if (event.type === "overflow") {
          // The loop reaches here only once recovery is exhausted - it retries with
          // cheap recovery first (emitting `recovered` status below). This terminal
          // overflow means the cheap rungs couldn't make the turn fit.
          yield* flushAll;
          yield* emit.publish(events.assistantOverflow({ runId, reason: event.reason }));
        } else if (event.type === "recovered") {
          // A recovery adjustment landed: finalize the current segment and surface a
          // live status, then the retry's output streams below it (D-038).
          yield* flushAll;
          yield* emit.publish(
            events.assistantRecovered({
              runId,
              action: event.action,
              detail: event.detail,
              reclaimed: event.reclaimed,
            }),
          );
        } else if (event.type === "reconnecting") {
          // A transient provider outage is being auto-retried before any token streamed (D-079):
          // surface a live "reconnecting (attempt k)" status; the retry's output streams below it.
          // Track the count so a turn that still fails is recorded as retry-EXHAUSTED (D-076 M6).
          reconnectAttempts = event.attempt;
          yield* flushAll;
          yield* emit.publish(
            events.assistantReconnecting({
              runId,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              detail: event.detail,
              ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
            }),
          );
        } else if (event.type === "empty") {
          // The model ended the turn with no reply (and the retry didn't help). Mark it
          // so the terminal completion shows a notice instead of an empty bubble.
          yield* flushAll;
          noReply = true;
        } else if (event.type === "stop") {
          yield* flushAll;
          stop = event.stop;
          if (event.diagnostic) {
            diagnostic = event.diagnostic;
          }
          yield* Effect.promise(() =>
            recordTurnStop({
              runId,
              provider: provider.id,
              model: provider.model,
              stop: event.stop,
              at: new Date().toISOString(),
            }),
          );
        } else if (event.type === "step_limit") {
          // The loop hit its budget and is forcing a final answer (which streams after this
          // as ordinary text). Record the step count so the completion is flagged with WHY,
          // distinct from a clean answer; flush so the forced answer reads as a new segment.
          yield* flushAll;
          stepLimitSteps = event.steps;
        } else if (event.type === "guardrail") {
          // A tool-call guardrail flagged a repeating path (07): publish the REDACTED marker - the
          // decision action/reason/count, the tool name, and short fingerprints only. The raw args,
          // raw output, and model-facing guidance never ride this event (D-005); the guidance was
          // appended to the tool result the model reads.
          const decision = event.decision;
          yield* emit.publish(
            events.toolGuardrail({
              runId,
              callId: event.call.id,
              name: event.call.name,
              action: decision.action,
              reason: decision.reason,
              count: decision.count,
              argsFingerprint: decision.argsFingerprint,
              ...(decision.resultFingerprint
                ? { resultFingerprint: decision.resultFingerprint }
                : {}),
              ...(decision.failureFingerprint
                ? { failureFingerprint: decision.failureFingerprint }
                : {}),
            }),
          );
        } else if (event.type === "checkpoint") {
          // A step-budget checkpoint auto-continued the turn (02.17): the adaptive budget was reached
          // with headroom + progress below the emergency ceiling. Finalize the open segment and surface
          // a quiet, durable breadcrumb; the continued output streams below it. Modeled on `recovered`.
          yield* flushAll;
          yield* emit.publish(
            events.assistantContinued({
              runId,
              steps: event.steps,
              pressure: event.pressure,
              threshold: event.threshold,
              detail: event.detail,
            }),
          );
        } else if (event.type === "model_switched") {
          // A mid-turn model/reasoning switch applied at a step boundary (09.1): finalize the open
          // segment and record the durable from/to model+reasoning so replay reconstructs the active
          // model and the web renders the switch marker; the next step's output streams below it.
          yield* flushAll;
          yield* emit.publish(
            events.modelSwitched({
              runId,
              from: event.from,
              to: event.to,
              initiator: event.initiator,
              outcome: event.outcome,
              ...(event.reason ? { reason: event.reason } : {}),
            }),
          );
          // A low-cardinality model-switch counter (plan 13 M5, D-010): outcome (applied/blocked) +
          // initiator are bounded, so a multi-model turn is observable without a high-cardinality label.
          recordMetric(sink, METRIC_NAMES.modelSwitch, 1, {
            outcome: event.outcome,
            initiator: event.initiator,
          });
        } else {
          // input is the prompt size of the latest step (current context); output sums.
          usage = {
            input: event.usage.input,
            output: (usage?.output ?? 0) + event.usage.output,
            contextWindow: event.usage.contextWindow,
            genMs: (usage?.genMs ?? 0) + event.usage.genMs,
          };
          // Surface the context as it grows: publish a live snapshot each step so the
          // panel's ctx meter and Request treemap fill in mid-turn instead of jumping at
          // completion. The terminal assistant.completed still carries the authoritative
          // final usage + breakdown.
          yield* emit.publish(
            events.assistantProgress({ runId, usage, breakdown: breakdown.snapshot() }),
          );
        }
      });

    yield* Stream.runForEach(
      runAgent(provider, history, reasoning, runId, useTools, {
        toolNames,
        delegate,
        telemetry: sink,
        ...(turnHooks ? { hooks: turnHooks } : {}),
        ...(loop ? { loop } : {}),
        ...(seedUsage ? { seedUsage } : {}),
        ...(switchCell ? { switch: switchCell } : {}),
        ...(rebuildProvider ? { rebuildProvider } : {}),
        ...(initialModel ? { initialModel } : {}),
      }),
      handle,
      // The whole turn is a `trevor.turn` span (provider + model + ok/error/interrupted status); the
      // per-tool spans nest under it. It wraps the run BEFORE the terminal onExit/catchAll below, so the
      // span sees the real success/failure/cancel exit rather than the swallowed one.
    ).pipe(
      spanEffect(sink, SPAN_NAMES.turn, { provider: provider.id, model: provider.model }),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          yield* flushAll;
          yield* Effect.sync(() => logUsageBreakdown(runId, breakdown, usage));
          const result = interpretFiberExit(exit);

          // The Stop dispatch rule (25 M7): only a genuine terminal assistant result - the
          // success exit, including budget/halt/no-reply stops - is reviewable. It runs before
          // the metrics below so a hook halt is counted under its real cause. The gate is
          // defect-proofed (25 simplify C1): dispatchStop itself never rejects (D-007), but a
          // fault in a hooks BINDING (a broken discovery/approvals layer in a hand-wired
          // TurnHooks) must never suppress the terminal completion - it downgrades to a warn
          // and the completion below publishes unconditionally.
          if (result.tag === "ok") {
            yield* stopHookGate.pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() =>
                  warn("hooks", "stop hook gate failed; finalizing without it", {
                    run: runId.slice(0, 8),
                    cause: Cause.pretty(cause).slice(0, 300),
                  }),
                ),
              ),
            );
          }
          // Any hook.decision still queued (the Stop gate's own, or a straggler from a turn
          // that ended mid-batch) publishes BEFORE the terminal completion below (M9).
          yield* flushHookEvents;

          // A low-cardinality turn-stop counter for EVERY turn (plan 13 M5): a terminal stop's rich cause
          // when present, else the exit disposition (answered/cancelled/failed). All labels are bounded
          // vocabularies - never a run id or prompt - so this aggregates cleanly.
          const stopCause =
            stop?.cause ??
            (result.tag === "ok"
              ? "answered"
              : result.tag === "cancelled"
                ? "cancelled"
                : "failed");
          recordMetric(sink, METRIC_NAMES.turnStop, 1, {
            cause: stopCause,
            provider: provider.id,
            model: provider.model,
          });
          // The turn's provider reconnect count (plan 13 M5), recorded only when it retried at all, so a
          // clean turn adds no noise. Bounded provider/model labels only.
          if (reconnectAttempts > 0) {
            recordMetric(sink, METRIC_NAMES.retryCount, reconnectAttempts, {
              provider: provider.id,
              model: provider.model,
            });
          }

          if (result.tag === "ok") {
            // A clean end OR a malformed-protocol anomaly (which ends the stream successfully with a
            // typed diagnostic): record the latter as the provider's latest incident.
            yield* recordProviderIncident(diagnostic, { runId });
            yield* complete({});
          } else if (result.tag === "cancelled") {
            yield* complete({ cancelled: true });
          } else {
            const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
            // Record the terminal provider failure for /doctor (D-076 M6), tagged retry-exhausted
            // (the loop emitted reconnect attempts and still failed) vs non-retryable terminal. The
            // detail is the already-sanitized error message; the log re-redacts defensively.
            if (Option.isSome(failure)) {
              yield* recordTerminalProviderFailure(provider, failure.value, {
                reconnectAttempts,
                runId,
                ...(traceWriter ? { traceWriter } : {}),
              });
            }
            const unavailable =
              Option.isSome(failure) && failure.value instanceof ProviderUnavailable
                ? failure.value
                : undefined;
            yield* complete({
              error: Option.isSome(failure) ? failure.value.message : "stream failed",
              ...(unavailable?.diagnostic ? { diagnostic: unavailable.diagnostic } : {}),
            });
          }
        }),
      ),
      // The terminal event is emitted in onExit above; swallow the (already-surfaced)
      // provider failure so the turn fiber settles cleanly.
      Effect.catchAll(() => Effect.void),
    );
  });
}
