import assert from "node:assert/strict";
import { test } from "vitest";
import { clampToolbarPosition } from "./quote-selection-placement";

/**
 * Table-driven coverage for the toolbar's viewport clamp. Pure math, so it runs in
 * the fast node `unit` project (no jsdom, no layout). Each case states an anchor,
 * toolbar size, and viewport, then asserts the final box never escapes the padded
 * viewport and keeps its center over the anchor when there is room.
 */

const VIEWPORT = { width: 1000, height: 800 };
const TOOLBAR = { width: 220, height: 32 };
const PADDING = 8;
const GAP = 8;

const opts = { padding: PADDING, gap: GAP };

/** A box stays inside the padded viewport on all four sides. */
const assertInside = (
  rect: { left: number; top: number },
  toolbar: { width: number; height: number },
  viewport: { width: number; height: number },
) => {
  assert.ok(rect.left >= PADDING, `left ${rect.left} >= ${PADDING}`);
  assert.ok(rect.top >= PADDING, `top ${rect.top} >= ${PADDING}`);
  assert.ok(
    rect.left + toolbar.width <= viewport.width - PADDING,
    `right ${rect.left + toolbar.width} <= ${viewport.width - PADDING}`,
  );
  assert.ok(
    rect.top + toolbar.height <= viewport.height - PADDING,
    `bottom ${rect.top + toolbar.height} <= ${viewport.height - PADDING}`,
  );
};

test("centers the toolbar over an anchor with room on every side", () => {
  const rect = clampToolbarPosition({ x: 500, y: 400 }, TOOLBAR, VIEWPORT, opts);
  assert.equal(rect.left, 500 - TOOLBAR.width / 2);
  assert.equal(rect.top, 400 - GAP - TOOLBAR.height);
  assertInside(rect, TOOLBAR, VIEWPORT);
});

test("slides inward at the left edge instead of clipping", () => {
  const rect = clampToolbarPosition({ x: 4, y: 400 }, TOOLBAR, VIEWPORT, opts);
  assert.equal(rect.left, PADDING);
  assertInside(rect, TOOLBAR, VIEWPORT);
});

test("slides inward at the right edge instead of clipping", () => {
  const rect = clampToolbarPosition({ x: 996, y: 400 }, TOOLBAR, VIEWPORT, opts);
  assert.equal(rect.left, VIEWPORT.width - PADDING - TOOLBAR.width);
  assertInside(rect, TOOLBAR, VIEWPORT);
});

test("flips below the anchor when there is no room above", () => {
  const rect = clampToolbarPosition({ x: 500, y: 10 }, TOOLBAR, VIEWPORT, opts);
  // Above (10 - 8 - 32 = -30) clips, so it lands below the anchor.
  assert.equal(rect.top, 10 + GAP);
  assertInside(rect, TOOLBAR, VIEWPORT);
});

test("pins to the left padding when the toolbar is wider than the viewport", () => {
  const tinyViewport = { width: 200, height: 600 };
  const rect = clampToolbarPosition({ x: 100, y: 300 }, TOOLBAR, tinyViewport, opts);
  // 200 - 8 - 220 is negative, so max() keeps the lower padding bound from inverting.
  assert.equal(rect.left, PADDING);
});

test("keeps a wider Tangent-enabled toolbar inside the right edge", () => {
  const wide = { width: 320, height: 32 };
  const rect = clampToolbarPosition({ x: 990, y: 400 }, wide, VIEWPORT, opts);
  assert.equal(rect.left, VIEWPORT.width - PADDING - wide.width);
  assertInside(rect, wide, VIEWPORT);
});

test("clamps the bottom edge for an anchor near the viewport floor", () => {
  const rect = clampToolbarPosition({ x: 500, y: 798 }, TOOLBAR, VIEWPORT, opts);
  // Above the anchor still fits vertically, so it stays above and inside.
  assertInside(rect, TOOLBAR, VIEWPORT);
});
