import { rollupBreakdown, type UsageBreakdown } from "@trevor/session";
import type { TreemapLeaf } from "./treemap-layout";

/**
 * Adapts the canonical `@trevor/session` breakdown rollup (the single source of the grouping + colors,
 * D-013) into the treemap leaves + legend total for the "data in this call" panel. The only web-local
 * step is resolving each row's semantic color token into a CSS variable; the grouping (tool results,
 * thinking, final response, prompt overhead) and labels are no longer redefined here. The per-tool
 * split is intentionally not surfaced - it's too granular.
 */

export interface PanelBreakdown {
  readonly leaves: TreemapLeaf[];
  /** Total chars across the shown categories, for legend percentages. */
  readonly total: number;
}

export function panelBreakdown(b: UsageBreakdown): PanelBreakdown {
  const rows = rollupBreakdown(b);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  // Drop empty cells; the treemap floors the rest to a minimum visible size (squarify's minFraction).
  const leaves: TreemapLeaf[] = rows
    .filter((row) => row.value > 0)
    .map((row) => ({
      key: row.key,
      label: row.label,
      value: row.value,
      color: `hsl(var(--${row.color}))`,
    }));
  return { leaves, total };
}
