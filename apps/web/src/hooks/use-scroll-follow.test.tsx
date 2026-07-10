import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { test } from "vitest";
import { useScrollFollow } from "./use-scroll-follow";

/**
 * The React adapter over the follow controller (plan 12.2 M3, reshaped by Tier 2.4). These tests pin
 * the adapter's contract: an upward gesture unpins SYNCHRONOUSLY within the same event (no intent
 * window), the pin bit stays readable on the controller (the JumpToBottom leaf subscribes to it), the
 * re-pin / unseen affordances route through the controller + the adapter's `ui` store, and the
 * returned handle is identity-stable so scroll-state changes never re-render the owner. The pin
 * policy itself is covered by scroll-follow.test.ts.
 */

function setScrollElement(
  ref: React.RefObject<HTMLDivElement | null>,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(ref, "current", {
    configurable: true,
    value: geometry as HTMLDivElement,
  });
}

test("an upward gesture unpins synchronously", () => {
  const { result } = renderHook(() => useScrollFollow(2));
  // Sitting at the live edge, pinned - the jump button is hidden.
  assert.equal(result.current.controller.isPinned(), true);

  // A single wheel-up gesture unpins in the same act: no position precondition, no 700ms window.
  act(() => result.current.onUserGesture("up"));

  assert.equal(result.current.controller.isPinned(), false);
});

test("a downward gesture alone does not re-pin", () => {
  const { result } = renderHook(() => useScrollFollow(2));
  act(() => result.current.onUserGesture("up"));
  assert.equal(result.current.controller.isPinned(), false);

  act(() => result.current.onUserGesture("down"));

  assert.equal(result.current.controller.isPinned(), false);
});

test("the handle is identity-stable across pin flips and appended items", () => {
  // Tier 2.4: the owner (App) must be able to hold this object forever - scroll-follow state reaches
  // the leaves through subscriptions, never through a re-minted container.
  const { result, rerender } = renderHook(({ count }) => useScrollFollow(count), {
    initialProps: { count: 2 },
  });
  const first = result.current;
  act(() => result.current.onUserGesture("up"));
  rerender({ count: 5 });
  assert.equal(result.current, first);
});

test("marks appended content unseen while unpinned and clears it on a return to the bottom", () => {
  const { result, rerender } = renderHook(({ count }) => useScrollFollow(count), {
    initialProps: { count: 2 },
  });
  setScrollElement(result.current.transcriptRef, {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
  });
  // Establish the baseline position, then scroll up (unpin) and let a row append below the fold.
  act(() => result.current.onScroll());
  act(() => result.current.onUserGesture("up"));
  setScrollElement(result.current.transcriptRef, {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 100,
  });
  act(() => result.current.onScroll());
  rerender({ count: 3 });

  assert.equal(result.current.controller.isPinned(), false);
  assert.equal(result.current.ui.hasUnseen(), true);

  // A genuine scroll back down arriving at the live edge re-pins and clears the unseen flag - no
  // wheel gesture required (the controller recognizes the arrival from the scroll event itself).
  setScrollElement(result.current.transcriptRef, {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
  });
  act(() => result.current.onScroll());

  assert.equal(result.current.controller.isPinned(), true);
  assert.equal(result.current.ui.hasUnseen(), false);
});

test("keyboard/scrollbar-style scrolling (no wheel gesture) unpins and re-pins at the bottom", () => {
  // A user on keyboard (PageUp/End) or a scrollbar drag produces ONLY scroll events - no wheel
  // gesture ever fires. Both directions must still work through the controller's scroll-event path.
  const { result } = renderHook(() => useScrollFollow(2));
  setScrollElement(result.current.transcriptRef, {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
  });
  act(() => result.current.onScroll()); // baseline at the bottom
  assert.equal(result.current.controller.isPinned(), true);

  // PageUp: an unattributed upward scroll -> unpins.
  setScrollElement(result.current.transcriptRef, {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 200,
  });
  act(() => result.current.onScroll());
  assert.equal(result.current.controller.isPinned(), false);

  // End: a genuine downward arrival at the bottom -> re-pins.
  setScrollElement(result.current.transcriptRef, {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
  });
  act(() => result.current.onScroll());
  assert.equal(result.current.controller.isPinned(), true);
});

test("scrollToBottom re-pins and increments the request id", () => {
  const { result } = renderHook(() => useScrollFollow(2));
  act(() => result.current.onUserGesture("up"));
  assert.equal(result.current.controller.isPinned(), false);

  act(() => result.current.scrollToBottom());

  assert.equal(result.current.controller.isPinned(), true);
  assert.equal(result.current.ui.bottomRequestId(), 1);
});

test("pinToBottom re-pins and requests a live-edge scroll on submit", () => {
  const { result } = renderHook(() => useScrollFollow(2));
  act(() => result.current.onUserGesture("up"));
  assert.equal(result.current.controller.isPinned(), false);

  act(() => result.current.pinToBottom());

  assert.equal(result.current.controller.isPinned(), true);
  assert.equal(result.current.ui.bottomRequestId(), 1);
});

test("pinToBottom requests a live-edge scroll even when already pinned", () => {
  const { result } = renderHook(() => useScrollFollow(2));
  assert.equal(result.current.controller.isPinned(), true);

  act(() => result.current.pinToBottom());

  assert.equal(result.current.controller.isPinned(), true);
  assert.equal(result.current.ui.bottomRequestId(), 1);
});
