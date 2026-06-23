import { events } from "@trevor/richter";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { type AgentEvent, runAgent } from "./agent/loop";
import type { ChatMessage, Provider, Usage } from "./providers";
import { Emit } from "./services";

/** Stream deltas are coalesced until this many chars accumulate, then flushed. */
const DELTA_FLUSH_CHARS = 40;

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
  options: { readonly runId: string; readonly reasoning?: string },
): Effect.Effect<void, never, Emit> {
  const { runId, reasoning } = options;
  return Effect.gen(function* () {
    const emit = yield* Emit;
    const { warm } = yield* provider.readiness();
    yield* emit.publish(
      events.assistantStarted({ runId, warm, model: provider.model, provider: provider.id }),
    );

    let full = "";
    let usage: Usage | undefined;
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
      emit.publish(events.assistantCompleted({ runId, text: full, usage, ...extra }));

    const handle = (event: AgentEvent) =>
      Effect.gen(function* () {
        if (event.type === "text") {
          full += event.text;
          yield* text.add(event.text);
        } else if (event.type === "thinking") {
          yield* thinking.add(event.text);
        } else if (event.type === "tool_start") {
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
          yield* emit.publish(
            events.toolCompleted({
              runId,
              callId: event.call.id,
              name: event.call.name,
              result: event.result.slice(0, 4000),
            }),
          );
        } else if (event.type === "overflow") {
          // Surface the overflow so the user sees why a turn was cut short. Graceful
          // auto-recovery (compact/adjust and continue) is planned separately.
          yield* flushAll;
          yield* emit.publish(events.assistantOverflow({ runId, reason: event.reason }));
        } else {
          // input is the prompt size of the latest step (current context); output sums.
          usage = {
            input: event.usage.input,
            output: (usage?.output ?? 0) + event.usage.output,
            contextWindow: event.usage.contextWindow,
            genMs: (usage?.genMs ?? 0) + event.usage.genMs,
          };
        }
      });

    yield* Stream.runForEach(runAgent(provider, turnHistory, reasoning, runId), handle).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          yield* flushAll;
          if (Exit.isSuccess(exit)) {
            yield* complete({});
          } else if (Cause.isInterruptedOnly(exit.cause)) {
            yield* complete({ cancelled: true });
          } else {
            const failure = Cause.failureOption(exit.cause);
            yield* complete({
              error: Option.isSome(failure) ? failure.value.message : "stream failed",
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
