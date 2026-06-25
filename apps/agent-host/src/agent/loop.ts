import { Effect, Option, Stream } from "effect";
import type { ChatMessage, ModelEvent, Provider, ProviderError, ToolCall } from "../providers";
import { executeTool, TOOL_DEFS } from "../tools";
import { reduceReasoning, trimLargestToolResult } from "./recovery";

/** Runaway backstop, NOT the everyday governor: it only bounds a pathological tool loop
 *  that never converges. The real budget is context pressure (CONTEXT_BUDGET_FRACTION below),
 *  so a turn normally stops because it's out of ROOM, never at an arbitrary step count (D-053). */
const MAX_STEPS = 32;
/** Stop opening new tool rounds once the latest prompt reaches this fraction of the model's
 *  context window, and force a final answer instead. Falls back to MAX_STEPS-only when the
 *  window is unknown (0). This is the governor; MAX_STEPS is the backstop (D-053). */
const CONTEXT_BUDGET_FRACTION = 0.8;
/** Per-turn cap on in-loop overflow-recovery adjustments, independent of MAX_STEPS so
 *  recovery can never spin (D-037). */
const MAX_RECOVERY = 2;

/** One event from the agent loop: the shared model-step events (`ModelEvent`: text,
 *  thinking, usage, overflow) forwarded unchanged from the provider, plus the loop-only
 *  cases - tool start/end (the loop turns a provider tool_call into these as it executes),
 *  a recovery adjustment (an in-turn overflow rung - distinct from compaction, the durable
 *  history summarization deferred to D-036), a `step_limit` (the turn hit its budget and is
 *  forcing a final answer - D-051), or an empty answer. */
export type AgentEvent =
  | ModelEvent
  | { readonly type: "tool_start"; readonly call: ToolCall }
  | { readonly type: "tool_end"; readonly call: ToolCall; readonly result: string }
  | {
      readonly type: "recovered";
      readonly action: "trim" | "reduce-thinking";
      readonly detail: string;
      readonly reclaimed: number;
    }
  | { readonly type: "step_limit"; readonly steps: number }
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

  // The latest model step's prompt size + window, captured from its usage event (like
  // overflowReason). Drives the context-pressure budget (D-053): when the prompt that fed
  // the last step crosses CONTEXT_BUDGET_FRACTION of the window, the next round forces a
  // final answer instead of opening more tool calls. Both 0 until the first usage arrives.
  let lastInputTokens = 0;
  let lastContextWindow = 0;

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
  const synthesize = (n: number): Stream.Stream<AgentEvent, ProviderError> =>
    Stream.suspend(() => {
      conversation.push({
        role: "user",
        content:
          "You have reached your tool-call budget for this turn. Do not call any more tools. " +
          "Answer the original request now, as completely as you can from what you have already gathered.",
      });
      const synthReasoning = provider.reasoningLevels.includes("off")
        ? "off"
        : provider.reasoningLevels[0];
      let answer = "";
      const model = provider.stream(conversation, [], synthReasoning).pipe(
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
      const afterSynthesis = Stream.unwrap(
        Effect.sync(() =>
          answer.trim() === "" ? Stream.succeed<AgentEvent>({ type: "empty" }) : Stream.empty,
        ),
      );
      return Stream.concat(
        Stream.succeed<AgentEvent>({ type: "step_limit", steps: n }),
        Stream.concat(model, afterSynthesis),
      );
    });

  // Stream.suspend keeps each step lazy: its provider.stream (which reads `conversation`)
  // is constructed only when the stream actually reaches this step - after the prior
  // step's tools have run and threaded their results - never eagerly while building it.
  const step = (n: number): Stream.Stream<AgentEvent, ProviderError> =>
    Stream.suspend(() => {
      // Budget gate before opening another tool round: the step backstop OR - the real
      // governor - the prior step's prompt crossing CONTEXT_BUDGET_FRACTION of the window.
      // Either way force a final answer rather than ending on a tool stub. At step 0 both are
      // clear (no prior usage), so the first round always runs.
      const overContext =
        lastContextWindow > 0 && lastInputTokens >= CONTEXT_BUDGET_FRACTION * lastContextWindow;
      if (n >= MAX_STEPS || overContext) {
        return synthesize(n);
      }
      const toolCalls: ToolCall[] = [];
      let assistantText = "";
      let overflowReason: string | null = null;

      // The model step: forward the shared ModelEvent variants (text/thinking/usage)
      // straight through - they ARE AgentEvents - while siphoning off assistant text
      // (accumulated), tool calls (collected, into tool_start/tool_end below), and any
      // overflow (captured for recovery below - not surfaced here).
      const modelStep = provider.stream(conversation, tools, currentReasoning).pipe(
        Stream.filterMap((event) => {
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
          }
          // text/thinking/usage flow through unchanged (shared ModelEvent shapes).
          return Option.some<AgentEvent>(event);
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
