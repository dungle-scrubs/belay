import type { ChatMessage } from "../providers";

/**
 * Cross-provider conversation normalization (plan 09.1 M6). A mid-turn swap to a DIFFERENT provider
 * carries the conversation that grew under provider A onto provider B, whose replay rules differ. Two
 * provider-specific encodings can make that replay fail, so this pure pass neutralizes both:
 *
 *   - **Tool-call / tool-result ids.** Provider A mints ids in its own scheme (e.g. `toolu_01ab…`,
 *     `call_AbC…`); a strict provider B can reject a foreign id format. We re-id every tool call to a
 *     neutral `call_N` scheme, rewriting each assistant `toolCalls[].id` and the matching tool-result
 *     `toolCallId` together so the pairing the providers require is preserved.
 *   - **Assistant thinking-block signatures.** A provider that inlines a signed reasoning block into the
 *     assistant turn (extended-thinking signatures) produces content provider B cannot verify. We strip
 *     any `<thinking>…</thinking>` block from assistant content, leaving the plain answer + tool calls.
 *
 * Same-provider swaps need none of this (the encodings already match), so the loop only runs this at the
 * cross-provider boundary. Pure: returns a new array, never mutates its input.
 *
 * Responsible for: normalizing a carried conversation for a cross-provider swap - neutral
 * tool-call ids and stripped thinking blocks.
 */

const THINKING_BLOCK = /<thinking>[\s\S]*?<\/thinking>/gu;

export function normalizeConversationForProvider(
  conversation: readonly ChatMessage[],
): ChatMessage[] {
  const idMap = new Map<string, string>();
  let seq = 0;
  // Map a provider-specific id to a stable neutral one, reused for the assistant call + its tool result.
  const neutralId = (old: string): string => {
    const existing = idMap.get(old);
    if (existing !== undefined) {
      return existing;
    }
    seq += 1;
    const id = `call_${seq}`;
    idMap.set(old, id);
    return id;
  };

  return conversation.map((message) => {
    let next = message;
    if (message.toolCalls && message.toolCalls.length > 0) {
      next = {
        ...next,
        toolCalls: message.toolCalls.map((call) => ({ ...call, id: neutralId(call.id) })),
      };
    }
    if (message.toolCallId !== undefined) {
      next = { ...next, toolCallId: neutralId(message.toolCallId) };
    }
    if (message.role === "assistant" && message.content.includes("<thinking>")) {
      next = { ...next, content: message.content.replace(THINKING_BLOCK, "").trim() };
    }
    return next;
  });
}
