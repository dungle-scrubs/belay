/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk, 2000). Pure geometry,
 * kept out of the React component so it can be reasoned about and verified on its
 * own. Lays a set of weighted leaves into a width x height box as rectangles whose
 * aspect ratios stay as close to square as the data allows.
 */

export interface TreemapLeaf {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** CSS color (e.g. `hsl(var(--smui-frost-3))`). */
  readonly color: string;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PlacedLeaf extends TreemapLeaf {
  readonly rect: Rect;
}

/** Worst (largest) aspect ratio in a row of areas laid along `side`. */
function worstRatio(areas: readonly number[], side: number): number {
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

export function squarify(
  leaves: readonly TreemapLeaf[],
  width: number,
  height: number,
  options?: {
    /**
     * Floor every leaf to at least this fraction of the box area (relative to
     * the true total) so small categories stay visible. Layout uses the floored
     * weights; each `PlacedLeaf` keeps its true `value` for labels/percentages.
     */
    readonly minFraction?: number;
  },
): PlacedLeaf[] {
  const items = leaves.filter((l) => l.value > 0);
  const total = items.reduce((s, l) => s + l.value, 0);
  if (total <= 0 || width <= 0 || height <= 0) return [];

  const minWeight = Math.max(options?.minFraction ?? 0, 0) * total;
  const weighted = items.map((leaf) => ({ leaf, weight: Math.max(leaf.value, minWeight) }));
  const weightTotal = weighted.reduce((s, w) => s + w.weight, 0);

  // Scale weights so the sum of areas equals the box area.
  const scale = (width * height) / weightTotal;
  const queue = weighted
    .map(({ leaf, weight }) => ({ leaf, area: weight * scale }))
    .sort((a, b) => b.area - a.area);

  const placed: PlacedLeaf[] = [];
  let free: Rect = { x: 0, y: 0, w: width, h: height };
  let row: { leaf: TreemapLeaf; area: number }[] = [];

  const flushRow = (): void => {
    if (row.length === 0) return;
    const side = Math.min(free.w, free.h);
    const sum = row.reduce((s, r) => s + r.area, 0);
    const thick = sum / side; // depth of the row, along the longer dimension
    const wide = free.w >= free.h; // a wide box gets a vertical strip on its left edge
    let off = wide ? free.y : free.x;
    for (const r of row) {
      const len = r.area / thick;
      placed.push({
        ...r.leaf,
        rect: wide
          ? { x: free.x, y: off, w: thick, h: len }
          : { x: off, y: free.y, w: len, h: thick },
      });
      off += len;
    }
    free = wide
      ? { x: free.x + thick, y: free.y, w: free.w - thick, h: free.h }
      : { x: free.x, y: free.y + thick, w: free.w, h: free.h - thick };
    row = [];
  };

  for (const candidate of queue) {
    const side = Math.min(free.w, free.h);
    if (row.length === 0) {
      row.push(candidate);
      continue;
    }
    const current = row.map((r) => r.area);
    const withNext = [...current, candidate.area];
    if (worstRatio(withNext, side) <= worstRatio(current, side)) {
      row.push(candidate);
    } else {
      flushRow();
      row.push(candidate);
    }
  }
  flushRow();
  return placed;
}
