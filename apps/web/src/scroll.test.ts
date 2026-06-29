import assert from "node:assert/strict";
import { test } from "vitest";
import { AT_BOTTOM_TOLERANCE, atBottomOf, distanceFromBottom, mayAutoFollow } from "./scroll";

/**
 * Transcript scroll math (D-086): "at the live edge" is the distance from the BOTTOM of a normal
 * top-down column, not scrollTop 0. Pure number tests - no DOM/layout.
 */

test("distanceFromBottom is 0 when pinned and grows as the user scrolls up", () => {
  // Overflowing content, scrolled to the very bottom: scrollTop = scrollHeight - clientHeight.
  assert.equal(distanceFromBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }), 0);
  // Scrolled up 250px from the bottom.
  assert.equal(distanceFromBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 350 }), 250);
});

test("atBottomOf is true at/near the bottom and false when scrolled away", () => {
  assert.equal(atBottomOf({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }), true);
  // Within tolerance counts as bottom.
  assert.equal(
    atBottomOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600 - (AT_BOTTOM_TOLERANCE - 1),
    }),
    true,
  );
  // Just past tolerance is not bottom.
  assert.equal(
    atBottomOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600 - (AT_BOTTOM_TOLERANCE + 1),
    }),
    false,
  );
});

test("content shorter than the viewport reads as at-bottom (short session follows, no chevron)", () => {
  // An empty or short well: scrollHeight <= clientHeight, scrollTop 0.
  assert.equal(atBottomOf({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 }), true);
  assert.equal(atBottomOf({ scrollHeight: 400, clientHeight: 400, scrollTop: 0 }), true);
});

test("mayAutoFollow allows app auto-follow only while pinned (user scroll wins, D-001)", () => {
  // The single named gate every automatic bottom-follow checks: pinned follows, unpinned never does.
  assert.equal(mayAutoFollow(true), true);
  assert.equal(mayAutoFollow(false), false);
});
