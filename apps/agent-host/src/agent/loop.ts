import { Effect, Option, Stream } from "effect";
import type { ChatMessage, Provider, ProviderError, ToolCall, Usage } from "../providers";
import { executeTool, TOOL_DEFS } from "../tools";
import { reduceReasoning, trimLargestToolResult } from "./recovery";

const MAX_STEPS = 8;
/** Per-turn cap on in-loop overflow-recovery adjustments, independent of MAX_STEPS so
 *  recovery can never spin (D-037). */
const MAX_RECOVERY = 2;

/** One event from the agent loop: text, thinking, a tool call, usage, overflow, a
 *  recovery adjustment (an in-turn overflow rung - distinct from compaction, the
 *  durable history summarization deferred to D-036), or an empty answer. */
export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool_start"; readonly call: ToolCall }
  | { readonly type: "tool_end"; readonly call: ToolCall; readonly result: string }
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "overflow"; readonly reason: string }
  | {
      readonly type: "recovered";
      readonly action: "trim" | "reduce-thinking";
      readonly detail: string;
      readonly reclaimed: number;
    }
  | { readonly type: "empty" };

/**
 * The model<->tools loop as a Stream of AgentEvents: stream a model step; if it
 * requested tools, execute them (emitting start/end) and recurse; otherwise the model
 * answered and the stream ends. Bounded by MAX_STEPS to prevent runaway tool loops.
 *
 * Cancellation is fiber interruption: interrupting the consumer halts the recursion and
 * the in-flight provider stream tears its request down (A-004) - no manual abort checks.
 * `conversation`, and each step's `toolCalls`/`assistantText`, are mutable closures read
 * by the deferred (post-model-step) Stream stages after the model step has drained.
 */
export function runAgent(
  provider: Provider,
  history: readonly ChatMessage[],
  reasoning?: string,
  runId?: string,
  useTools = true,
): Stream.Stream<AgentEvent, ProviderError> {
  const conversation: ChatMessage[] = [...history];
  const tools = useTools ? TOOL_DEFS : [];
  // One retry budget for an empty answer (the model ending a turn with no text and no
  // tool calls). A single nudge often gets it to synthesize; if it stays empty we
  // surface it rather than ending silently.
  let emptyRetried = false;

  // Graceful overflow recovery (D-034..D-038): in-loop, per-turn, cheap rungs only,
  // bounded so it can never spin. Recovery adjusts the reasoning level and the in-loop
  // tool results (everything appended after the prior history starts at baseIndex).
  const baseIndex = history.length;
  let recoveryBudget = MAX_RECOVERY;
  let currentReasoning = reasoning;
  let thinkingReduced = false;

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

  // Stream.suspend keeps each step lazy: its provider.stream (which reads `conversation`)
  // is constructed only when the stream actually reaches this step - after the prior
  // step's tools have run and threaded their results - never eagerly while building it.
  const step = (n: number): Stream.Stream<AgentEvent, ProviderError> =>
    Stream.suspend(() => {
      if (n >= MAX_STEPS) {
        return Stream.empty;
      }
      const toolCalls: ToolCall[] = [];
      let assistantText = "";
      let overflowReason: string | null = null;

      // The model step: pass text/thinking/usage through as AgentEvents while siphoning
      // off assistant text (accumulated), tool calls (collected), and any overflow
      // (captured for recovery below - not surfaced here).
      const modelStep = provider.stream(conversation, tools, currentReasoning).pipe(
        Stream.filterMap((event) => {
          if (event.type === "text") {
            assistantText += event.text;
            return Option.some<AgentEvent>({ type: "text", text: event.text });
          }
          if (event.type === "thinking") {
            return Option.some<AgentEvent>({ type: "thinking", text: event.text });
          }
          if (event.type === "overflow") {
            // Capture; afterModel decides recover-and-retry vs terminal (D-035, D-038).
            overflowReason = event.reason;
            return Option.none<AgentEvent>();
          }
          if (event.type === "usage") {
            return Option.some<AgentEvent>({ type: "usage", usage: event.usage });
          }
          toolCalls.push(event.call);
          return Option.none<AgentEvent>();
        }),
      );

      // Built lazily (Stream.unwrap defers the thunk until the model step has drained), so
      // it reads the now-populated toolCalls/assistantText: run each tool in order, then
      // recurse to the next step. No tool calls means the model answered - stop.
      const afterModel = Stream.unwrap(
        Effect.sync(() => {
          // Overflow recovery: try one cheap in-loop adjustment and re-run the SAME step
          // (n unchanged, so recovery is independent of MAX_STEPS). Only when the budget
          // is spent does the terminal overflow surface (D-038).
          if (overflowReason !== null) {
            const recovered = tryRecover(overflowReason);
            if (recovered) {
              return Stream.concat(Stream.succeed(recovered), step(n));
            }
            return Stream.succeed<AgentEvent>({ type: "overflow", reason: overflowReason });
          }
          if (toolCalls.length === 0) {
            // The model answered. An answer with no text is a stall (it emitted only a
            // stop token) - retry the step once, then surface an `empty` event so the
            // turn never ends silently (which is what poisons the next turn's history).
            if (assistantText.trim() === "") {
              if (!emptyRetried) {
                emptyRetried = true;
                // An empty answer is usually the accumulated prior history poisoning the
                // model into an immediate stop. Retry against only the current task -
                // drop everything before this turn's own user message, keeping the work
                // it just did - which reliably recovers a real answer.
                conversation.splice(0, Math.max(0, history.length - 1));
                return step(n);
              }
              return Stream.succeed<AgentEvent>({ type: "empty" });
            }
            return Stream.empty;
          }
          conversation.push({
            role: "assistant",
            content: assistantText,
            toolCalls: [...toolCalls],
          });
          const toolRuns = toolCalls.map((call) =>
            Stream.concat(
              Stream.succeed<AgentEvent>({ type: "tool_start", call }),
              Stream.fromEffect(
                executeTool(call.name, call.arguments, runId).pipe(
                  Effect.map((result): AgentEvent => {
                    conversation.push({
                      role: "tool",
                      content: result,
                      toolCallId: call.id,
                      name: call.name,
                    });
                    return { type: "tool_end", call, result };
                  }),
                ),
              ),
            ),
          );
          const tools = toolRuns.reduce(
            (acc, one) => Stream.concat(acc, one),
            Stream.empty as Stream.Stream<AgentEvent, ProviderError>,
          );
          return Stream.concat(tools, step(n + 1));
        }),
      );

      return Stream.concat(modelStep, afterModel);
    });

  return step(0);
}
