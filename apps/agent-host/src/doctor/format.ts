/**
 * Tiny display formatting shared by the /doctor status rollups (plan 24 simplify pass): the
 * naive-plural noun helper and the compact status histogram both peripheral debug summaries
 * (./mcp-status, ./lsp-status) render, kept in one place so the two surfaces cannot drift.
 *
 * Responsible for: plural nouns and status-histogram lines for doctor rollups.
 * Not for: rollup classification (the status modules) or area rendering (snapshot.ts).
 */

/** "1 server" / "2 servers" - the naive plural every doctor count line uses. */
export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "2 ready · 1 failed" - status counts in first-seen order, joined by the doctor separator. */
export function statusHistogram(statuses: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const status of statuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(" · ");
}
