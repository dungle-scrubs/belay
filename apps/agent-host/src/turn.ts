import { events, type TurnStop } from "@trevor/session";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { type AgentEvent, type DelegateCapability, runAgent } from "./agent/loop";
import { recordTurnStopMetric } from "./agent/turn-stop-metrics";
import { resolveHistoryImages } from "./artifacts";
import { log } from "./log";
import { type ChatMessage, type Provider, ProviderUnavailable, type Usage } from "./providers";
import { providerFailures } from "./providers/provider-failure-log";
import { buildSystemPrompt } from "./providers/system-prompt";
import { Emit } from "./services";
import { TOOL_DEFS } from "./tools";
import { MAX_OUTPUT } from "./tools/shared";
import { BreakdownAccumulator, logUsageBreakdown } from "./usage/breakdown";

/** Stream deltas are coalesced until this many chars accumulate, then flushed. */
const DELTA_FLUSH_CHARS = 40;

/**
 * Minimum context window (tokens) required to run Trevor: the model needs room for the
 * ~5k system-prompt+tools floor plus headroom, or it returns empty with no signal, so
 * the turn fails loud with an actionable message instead. Override with TREVOR_MIN_CONTEXT.
 *
 * For the shipped product the CONFIGURED (loaded) window is what matters - a model
 * loaded below this should error. Right now the guard checks the model's NATIVE
 * capability (caps.contextLength) instead, purely as a testing affordance: it lets us
 * load a 256k-capable model at 4-6k to exercise overflow recovery without tripping the
 * guard. TODO (when overflow handling lands): switch the check to the served/loaded
 * window so a sub-16k configured window errors. Providers reporting 0 (unknown) are not
 * checked.
 */
const MIN_CONTEXT_TOKENS = Number(process.env.TREVOR_MIN_CONTEXT) || 16_384;

/**
 * Buffers streamed text on one channel (assistant.delta or assistant.thinking),
 * flushing once it crosses DELTA_FLUSH_CHARS or when explicitly flushed at a boundary
 * (tool call, overflow, turn end). add/flush are Effects; the pending buffer is read at
 * run time via Effect.suspend, so a flush always emits the latest accumulated text.
 */
class DeltaBuffer {
  private pending = "";

  constructor(private readonly publish: (text: string) => Effect.Effect<void>) {}

  add(text: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.pending += text;
      return this.pending.length >= DELTA_FLUSH_CHARS ? this.flush() : Effect.void;
    });
  }

  flush(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.pending) {
        return Effect.void;
      }
      const text = this.pending;
      this.pending = "";
      return this.publish(text);
    });
  }
}

/**
 * Runs the agent loop for one turn as an Effect and publishes its lifecycle through the
 * Emit service: assistant.started, buffered delta/thinking, tool.started/completed,
 * overflow, and a terminal assistant.completed. The completion is emitted exactly once
 * from an uninterruptible onExit, so the three exits each get the right terminal event:
 * normal end -> {}, a fiber interrupt (cancel) -> {cancelled}, a provider failure ->
 * {error}. Owns the buffering and the AgentEvent -> event mapping so the host's connect
 * path stays about transport, not turn bookkeeping.
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
  },
): Effect.Effect<void, never, Emit> {
  const { runId, reasoning, toolNames, delegate } = options;

  return Effect.gen(function* () {
    const emit = yield* Emit;

    const { warm } = yield* provider.readiness();

    // Inline image attachments before the model step, but only when the model actually accepts
    // images - detected first-class via capabilities(), never hardcoded per provider (D-028).
    const caps = yield* provider.capabilities();

    // Pre-flight capability guard: a model whose NATIVE context is below the minimum
    // can't fit the ~5k system-prompt+tools floor with room to work, so it would return
    // empty with no signal. Fail loud with an actionable message instead. Checks the
    // model's capability, not its loaded window - a model loaded small for overflow
    // testing still passes (its native ceiling is large).
    if (caps.contextLength > 0 && caps.contextLength < MIN_CONTEXT_TOKENS) {
      yield* emit.publish(
        events.assistantStarted({ runId, warm, model: provider.model, provider: provider.id }),
      );
      yield* emit.publish(
        events.assistantCompleted({
          runId,
          text: "",
          error: `Model ${provider.model} supports only ${caps.contextLength} tokens of context, below the ${MIN_CONTEXT_TOKENS} (16k) minimum required to run Trevor. Pick a model with at least 16k of context.`,
        }),
      );
      return;
    }

    // The prompt view is already model-safe: buildHistory (history-projection.ts) owns
    // the conversation-shaping invariants - blank assistant turns dropped, user/assistant
    // alternation enforced, no leading non-user turn - so a poisoned history can't push the
    // model into an empty stop (the cascade behind silent dead-ends). Only image inlining
    // (vision models only, D-028) is applied here.
    const history = caps.images
      ? yield* Effect.promise(() => resolveHistoryImages(turnHistory))
      : turnHistory;
    const useTools = caps.tools;

    // Token-source breakdown ("where does the context go?"). Fixed overhead = the
    // system prompt + the tool schemas the provider re-sends every step; the rest
    // is seeded from history and grows as the turn's tool results stream in.
    // A subagent only sees its allow-listed tools, so its overhead (system prompt + tool schemas)
    // is sized from that restricted set, matching what the model is actually offered; a parent's
    // overhead also covers the delegation tools it can call.
    const allDefs = useTools ? TOOL_DEFS : [];
    const allowedDefs = toolNames ? allDefs.filter((t) => toolNames.has(t.name)) : allDefs;
    const toolDefs = delegate ? [...allowedDefs, ...delegate.defs] : allowedDefs;
    const breakdown = new BreakdownAccumulator(
      buildSystemPrompt(toolDefs).length + (useTools ? JSON.stringify(toolDefs).length : 0),
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
    // How many auto-reconnect attempts the loop emitted this turn (D-076 M6): if the turn still
    // ends in a provider failure, a nonzero count means the bounded retry budget was EXHAUSTED (a
    // transient outage that gave up) - distinct from a non-retryable terminal failure, which never
    // reconnects. The /doctor surface reads the two categories separately.
    let reconnectAttempts = 0;

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

    const complete = (extra: { error?: string; cancelled?: boolean }) =>
      emit.publish(
        events.assistantCompleted({
          runId,
          text: full,
          usage,
          breakdown: breakdown.snapshot(),
          ...(noReply ? { noReply: true } : {}),
          ...(stepLimitSteps > 0 ? { stepLimit: stepLimitSteps } : {}),
          ...(stop ? { stop } : {}),
          ...extra,
        }),
      );

    const handle = (event: AgentEvent) =>
      Effect.gen(function* () {
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
          yield* Effect.promise(() =>
            recordTurnStopMetric({
              runId,
              provider: provider.id,
              model: provider.model,
              stop: event.stop,
              at: new Date().toISOString(),
            }),
          );
          yield* Effect.sync(() =>
            log("turn", "stop", {
              runId,
              provider: provider.id,
              model: provider.model,
              cause: event.stop.cause,
              action: event.stop.action,
              steps: event.stop.steps,
              inputTokens: event.stop.context?.inputTokens,
              contextWindow: event.stop.context?.contextWindow,
              pressure: event.stop.context?.pressure,
            }),
          );
        } else if (event.type === "step_limit") {
          // The loop hit its budget and is forcing a final answer (which streams after this
          // as ordinary text). Record the step count so the completion is flagged with WHY,
          // distinct from a clean answer; flush so the forced answer reads as a new segment.
          yield* flushAll;
          stepLimitSteps = event.steps;
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
      runAgent(provider, history, reasoning, runId, useTools, { toolNames, delegate }),
      handle,
    ).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          yield* flushAll;
          yield* Effect.sync(() => logUsageBreakdown(runId, breakdown, usage));

          if (Exit.isSuccess(exit)) {
            yield* complete({});
          } else if (Cause.isInterruptedOnly(exit.cause)) {
            yield* complete({ cancelled: true });
          } else {
            const failure = Cause.failureOption(exit.cause);
            // Record the terminal provider failure for /doctor (D-076 M6), tagged retry-exhausted
            // (the loop emitted reconnect attempts and still failed) vs non-retryable terminal. The
            // detail is the already-sanitized error message; the log re-redacts defensively.
            if (Option.isSome(failure)) {
              const error = failure.value;
              const unavailable = error instanceof ProviderUnavailable ? error : undefined;
              yield* Effect.sync(() =>
                providerFailures.record({
                  provider: provider.id,
                  model: provider.model,
                  classification: unavailable?.classification,
                  userAction: unavailable?.userAction,
                  retryExhausted: reconnectAttempts > 0,
                  attempts: reconnectAttempts,
                  status: unavailable?.evidence?.status,
                  code: unavailable?.evidence?.code,
                  shapeFields: unavailable?.evidence?.shapeFields,
                  detail: error.message,
                  at: new Date().toISOString(),
                }),
              );
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
