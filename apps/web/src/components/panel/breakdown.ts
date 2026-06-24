import { BREAKDOWN_CATEGORIES, type UsageBreakdown } from "@trevor/session";
import type { TreemapLeaf } from "./treemap-layout";

/**
 * Turns a host `UsageBreakdown` (character counts per category) into the treemap
 * leaves and the legend groups for the "data in this call" panel. The treemap is
 * a single combined view of where the call's tokens went, by category: tool
 * results, thinking, the final response, and the fixed prompt overhead. (The
 * per-tool split is intentionally not surfaced here - it's too granular.)
 */

const BLUE = "hsl(var(--smui-frost-3))";
const GOLD = "hsl(var(--smui-yellow))";
const GREEN = "hsl(var(--smui-green))";
const STEEL = "hsl(var(--muted-foreground))";

export interface LegendGroup {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

export interface PanelBreakdown {
  readonly leaves: TreemapLeaf[];
  readonly groups: LegendGroup[];
  /** Total chars across the shown categories, for legend percentages. */
  readonly total: number;
}

export function panelBreakdown(b: UsageBreakdown): PanelBreakdown {
  // Tool results vs. fixed overhead is the descriptor's `isOverhead` split, so this
  // rollup can never drift from the host's category set (byTool/images are not
  // categories, so the numeric cast never reads them).
  const inputCounts = b.input as unknown as Record<string, number>;
  const sumInput = (overheadGroup: boolean): number =>
    BREAKDOWN_CATEGORIES.reduce(
      (t, c) =>
        c.pool === "input" && c.isOverhead === overheadGroup ? t + (inputCounts[c.key] ?? 0) : t,
      0,
    );
  const toolTotal = sumInput(false);
  const thinking = b.output.thinking;
  const answer = b.output.answer;
  const overhead = sumInput(true);
  const total = toolTotal + thinking + answer + overhead;

  const allLeaves: TreemapLeaf[] = [];
  if (toolTotal > 0)
    allLeaves.push({ key: "tools", label: "tool results", value: toolTotal, color: BLUE });
  if (thinking > 0)
    allLeaves.push({ key: "thinking", label: "thinking", value: thinking, color: GOLD });
  if (answer > 0)
    allLeaves.push({ key: "answer", label: "final response", value: answer, color: GREEN });
  if (overhead > 0)
    allLeaves.push({ key: "overhead", label: "overhead", value: overhead, color: STEEL });

  // Keep every non-zero category: the treemap floors small cells to a minimum
  // visible size (see `squarify`'s `minFraction`) rather than dropping them.
  const leaves = allLeaves;

  // Legend lists every category that rounds to >= 1%, so a 0% row never shows.
  const groups: LegendGroup[] = [
    { key: "tools", label: "Tool results", value: toolTotal, color: BLUE },
    { key: "thinking", label: "Thinking", value: thinking, color: GOLD },
    { key: "answer", label: "Final response", value: answer, color: GREEN },
    { key: "overhead", label: "Overhead", value: overhead, color: STEEL },
  ].filter((g) => total > 0 && Math.round((g.value / total) * 100) >= 1);

  return { leaves, groups, total };
}
