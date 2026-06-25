import type { ChatMessage } from "../providers";

/** Chars kept from the start / end of a trimmed tool result. */
const HEAD = 800;
const TAIL = 400;
/** Don't bother trimming a result at or below this size - too little to reclaim. */
const MIN_TRIM = HEAD + TAIL + 200;
/** Sentinel marking an already-trimmed result, so a second pass skips it. */
export const ELISION = "elided to recover context";

export interface TrimResult {
  readonly reclaimed: number;
  readonly tool: string;
}

/**
 * Trims the largest in-loop tool result (index >= fromIndex) in place: keep the
 * head and tail, elide the middle with a marker. Returns the chars reclaimed and
 * the tool name, or null when nothing is worth trimming. Only this turn's results
 * are touched - prior history is never trimmed (D-034).
 */
export function trimLargestToolResult(
  conversation: ChatMessage[],
  fromIndex: number,
): TrimResult | null {
  let idx = -1;
  let len = 0;
  for (let i = Math.max(0, fromIndex); i < conversation.length; i += 1) {
    const m = conversation[i];
    if (m && m.role === "tool" && !m.content.includes(ELISION) && m.content.length > len) {
      idx = i;
      len = m.content.length;
    }
  }
  const target = idx >= 0 ? conversation[idx] : undefined;
  if (!target || len <= MIN_TRIM) {
    return null;
  }
  const elided = len - HEAD - TAIL;
  const trimmed = `${target.content.slice(0, HEAD)}\n\n… [${elided} chars ${ELISION}] …\n\n${target.content.slice(-TAIL)}`;
  conversation[idx] = { ...target, content: trimmed };
  return { reclaimed: target.content.length - trimmed.length, tool: target.name ?? "tool" };
}

/** The cheapest reasoning level for a mechanical (non-thinking) call - "off" when supported, else
 *  the lowest level (reasoningLevels is ordered low→high). Used by the summarizer and the forced
 *  final-answer synthesis, neither of which benefits from thinking. */
export function cheapestReasoning(levels: readonly string[]): string | undefined {
  return levels.includes("off") ? "off" : levels[0];
}

/** The reasoning level one notch below `current`, or null if already off/lowest. */
export function reduceReasoning(
  levels: readonly string[],
  current: string | undefined,
): string | null {
  if (!current || current === "off") {
    return null;
  }
  const i = levels.indexOf(current);
  if (i <= 0) {
    return null;
  }
  return levels[i - 1] ?? null;
}
