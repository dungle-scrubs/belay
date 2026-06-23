import { events, type TrevorEventInput } from "@trevor/richter";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { type AgentEvent, runAgent } from "./agent/loop";
import type { ChatMessage, Provider, Usage } from "./providers";

/** Stream deltas are coalesced until this many chars accumulate, then flushed. */
const DELTA_FLUSH_CHARS = 40;

/** Publishes one event after attaching this participant's producerId. */
export type Emit = (event: TrevorEventInput) => Promise<void>;

/**
 * Buffers streamed text on one channel (assistant.delta or assistant.thinking),
 * flushing once it crosses DELTA_FLUSH_CHARS or when explicitly flushed at a
 * boundary (tool call, overflow, turn end). One parametrized buffer replaces the
 * two near-identical text/thinking flush pairs the host carried inline.
 */
class DeltaBuffer {
  private pending = "";

  constructor(private readonly emit: (text: string) => Promise<void>) {}

  async add(text: string): Promise<void> {
    this.pending += text;
    if (this.pending.length >= DELTA_FLUSH_CHARS) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.pending) {
      return;
    }
    const text = this.pending;
    this.pending = "";
    await this.emit(text);
  }
}

/**
 * Runs the agent loop for one turn as an Effect and publishes its lifecycle:
 * assistant.started, buffered delta/thinking, tool.started/completed, overflow, and a
 * terminal assistant.completed. The completion is emitted exactly once from an
 * uninterruptible onExit, so the three exits each get the right terminal event:
 * normal end -> {}, a fiber interrupt (cancel) -> {cancelled}, a provider failure ->
 * {error}. Owns the buffering and the AgentEvent -> event mapping so the host's connect
 * path stays about transport, not turn bookkeeping.
 */
export function publishTurn(
  emit: Emit,
  provider: Provider,
  turnHistory: readonly ChatMessage[],
  options: { readonly runId: string; readonly reasoning?: string },
): Effect.Effect<void> {
  const { runId, reasoning } = options;
  return Effect.gen(function* () {
    const { warm } = yield* Effect.promise(() => provider.readiness());
    yield* Effect.promise(() =>
      emit(events.assistantStarted({ runId, warm, model: provider.model, provider: provider.id })),
    );

    let full = "";
    let usage: Usage | undefined;
    const text = new DeltaBuffer((delta) => emit(events.assistantDelta({ runId, text: delta })));
    // Reasoning text rides its own event channel so the browser can show or hide it.
    const thinking = new DeltaBuffer((delta) =>
      emit(events.assistantThinking({ runId, text: delta })),
    );
    const flushAll = Effect.promise(async () => {
      await text.flush();
      await thinking.flush();
    });
    const complete = (extra: { error?: string; cancelled?: boolean }) =>
      Effect.promise(() => emit(events.assistantCompleted({ runId, text: full, usage, ...extra })));

    const handle = (event: AgentEvent) =>
      Effect.promise(async () => {
        if (event.type === "text") {
          full += event.text;
          await text.add(event.text);
        } else if (event.type === "thinking") {
          await thinking.add(event.text);
        } else if (event.type === "tool_start") {
          await text.flush();
          await thinking.flush();
          await emit(
            events.toolStarted({
              runId,
              callId: event.call.id,
              name: event.call.name,
              arguments: event.call.arguments,
            }),
          );
        } else if (event.type === "tool_end") {
          await emit(
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
          await text.flush();
          await thinking.flush();
          await emit(events.assistantOverflow({ runId, reason: event.reason }));
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
