import { Effect, Option, Stream } from "effect";
import type { ChatMessage, Provider, ProviderError, ToolCall, Usage } from "../providers";
import { executeTool, TOOL_DEFS } from "../tools";

const MAX_STEPS = 8;

/** One event from the agent loop: text, thinking, a tool call, usage, or an overflow. */
export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool_start"; readonly call: ToolCall }
  | { readonly type: "tool_end"; readonly call: ToolCall; readonly result: string }
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "overflow"; readonly reason: string };

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

      // The model step: pass text/thinking/usage/overflow through as AgentEvents while
      // siphoning off assistant text (accumulated) and tool calls (collected, not emitted
      // here - tool_start/tool_end come during execution below).
      const modelStep = provider.stream(conversation, tools, reasoning).pipe(
        Stream.filterMap((event) => {
          if (event.type === "text") {
            assistantText += event.text;
            return Option.some<AgentEvent>({ type: "text", text: event.text });
          }
          if (event.type === "thinking") {
            return Option.some<AgentEvent>({ type: "thinking", text: event.text });
          }
          if (event.type === "overflow") {
            return Option.some<AgentEvent>({ type: "overflow", reason: event.reason });
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
          if (toolCalls.length === 0) {
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
