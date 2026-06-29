/**
 * Pure viewport-clamp math for the selection toolbar, kept apart from the React
 * component so it unit-tests without a DOM or layout engine (jsdom has neither).
 * The toolbar (quote-selection-toolbar.tsx) measures itself and feeds its size
 * plus the selection anchor in here; this returns the final fixed-position
 * top-left corner, already clamped inside the viewport.
 */

/** Viewport point the toolbar wants to sit above (pointer release or focus end). */
export type Anchor = { x: number; y: number };

/** Measured (or declared) toolbar box. */
export type ToolbarSize = { width: number; height: number };

/** The visible window the toolbar must stay inside. */
export type Viewport = { width: number; height: number };

/** Final fixed-position top-left corner for the toolbar element. */
export type ToolbarRect = { left: number; top: number };

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Places a `toolbar`-sized box above `anchor`, centered on it with a `gap`, then
 * clamps the box fully inside `viewport` leaving `padding` on every edge so all
 * actions stay reachable. Near the left/right edge the box slides inward instead
 * of being clipped; when there is no room above the anchor it flips below it.
 *
 * The returned `{ left, top }` is the box's top-left corner, so the component can
 * position with `left`/`top` directly and skip the translate transform that made
 * edge clamping impossible to reason about.
 */
export const clampToolbarPosition = (
  anchor: Anchor,
  toolbar: ToolbarSize,
  viewport: Viewport,
  options?: { padding?: number; gap?: number },
): ToolbarRect => {
  const padding = options?.padding ?? 8;
  const gap = options?.gap ?? 8;

  // Lower bound always wins over upper bound: when the toolbar is wider/taller
  // than the room available, pin it to the top-left padding rather than letting
  // the max fall below the min (which would clamp it off the opposite edge).
  const maxLeft = Math.max(padding, viewport.width - padding - toolbar.width);
  const maxTop = Math.max(padding, viewport.height - padding - toolbar.height);

  const left = clamp(anchor.x - toolbar.width / 2, padding, maxLeft);

  // Prefer above the anchor; flip below when the top would clip past the padding.
  const above = anchor.y - gap - toolbar.height;
  const top = clamp(above >= padding ? above : anchor.y + gap, padding, maxTop);

  return { left, top };
};
