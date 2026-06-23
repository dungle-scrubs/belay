import { events, type TrevorEventInput } from "@trevor/richter";
import { runAgent } from "./agent/loop";
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
 * Runs the agent loop for one turn and publishes its lifecycle: assistant.started,
 * buffered delta/thinking, tool.started/completed, overflow, and a terminal
 * assistant.completed (carrying accumulated usage, or an error if the loop threw).
 * Owns the buffering and the AgentEvent -> event mapping so the host's connect
 * path stays about transport, not turn bookkeeping.
 */
export async function publishTurn(
  emit: Emit,
  provider: Provider,
  turnHistory: readonly ChatMessage[],
  options: { readonly runId: string; readonly reasoning?: string; readonly signal?: AbortSignal },
): Promise<void> {
  const { runId, reasoning, signal } = options;
  const { warm } = await provider.readiness();
  await emit(
    events.assistantStarted({ runId, warm, model: provider.model, provider: provider.id }),
  );

  let full = "";
  let usage: Usage | undefined;
  const text = new DeltaBuffer((delta) => emit(events.assistantDelta({ runId, text: delta })));
  // Reasoning text rides its own event channel so the browser can show or hide it.
  const thinking = new DeltaBuffer((delta) =>
    emit(events.assistantThinking({ runId, text: delta })),
  );
  const flushAll = async (): Promise<void> => {
    await text.flush();
    await thinking.flush();
  };
  // The terminal event, emitted exactly once: a cancelled run (ESC) is distinct
  // from an errored one, and both carry whatever partial text already streamed.
  const complete = (extra: { error?: string; cancelled?: boolean }): Promise<void> =>
    emit(events.assistantCompleted({ runId, text: full, usage, ...extra }));

  try {
    for await (const event of runAgent(provider, turnHistory, reasoning, signal)) {
      if (event.type === "text") {
        full += event.text;
        await text.add(event.text);
      } else if (event.type === "thinking") {
        await thinking.add(event.text);
      } else if (event.type === "tool_start") {
        await flushAll();
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
        await flushAll();
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
    }
  } catch (error) {
    await flushAll();
    // On some transports an abort throws here instead of ending the stream; an
    // aborted signal means a clean cancel, anything else is a real error.
    if (signal?.aborted) {
      await complete({ cancelled: true });
    } else {
      await complete({ error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  await flushAll();
  await complete(signal?.aborted ? { cancelled: true } : {});
}
