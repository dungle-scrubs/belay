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
