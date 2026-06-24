import type { ChatMessage } from "../providers";

/** True when an assistant turn carries no answer text and no tool calls. */
const isBlankAssistant = (m: ChatMessage): boolean =>
  m.role === "assistant" && !m.toolCalls?.length && m.content.trim() === "";

/**
 * Sanitizes the conversation before it reaches the model (the "prompt view").
 * Local quantized models bail with an immediate stop token when the history is
 * malformed, so a single empty assistant turn early on poisons every later turn
 * (a blank reply gets saved, the model sees "empty replies are normal", and emits
 * another - a cascade). This defends against that and any other drift:
 *
 *   - drop blank assistant turns (a prior empty completion - the poison),
 *   - drop any leading non-user turn (the prompt must open on a user message),
 *   - collapse a run of consecutive user turns to the latest (alternation).
 *
 * Tool-call steps (empty content but real tool calls) and their tool results are
 * kept - they are well-formed and load-bearing.
 */
export function sanitizeHistory(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (isBlankAssistant(m)) {
      continue;
    }
    if (out.length === 0 && m.role !== "user") {
      continue;
    }
    const prev = out[out.length - 1];
    if (m.role === "user" && prev?.role === "user") {
      out[out.length - 1] = m;
      continue;
    }
    out.push(m);
  }
  return out;
}
