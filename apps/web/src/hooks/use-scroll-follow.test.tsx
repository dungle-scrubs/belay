import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { test } from "vitest";
import { useScrollFollow } from "./use-scroll-follow";

/**
 * The React adapter over the follow controller (plan 12.2 M3). These tests pin the adapter's contract:
 * an upward gesture unpins SYNCHRONOUSLY within the same event (no intent window), the pin state is
 * mirrored into render for the jump button, and the re-pin / unseen affordances route through the
 * controller. The pin policy itself is covered by scroll-follow.test.ts.
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

test("an upward gesture unpins synchronously, exposing the unpinned state to render", () => {
  const { result } = renderHook(() => useScrollFollow(2));
  // Sitting at the live edge, pinned - the jump button is hidden.
  assert.equal(result.current.atBottom, true);

  // A single wheel-up gesture unpins in the same act: no position precondition, no 700ms window.
  act(() => result.current.onUserGesture("up"));

  assert.equal(result.current.atBottom, false);
});

test("a downward gesture alone does not re-pin", () => {
  const { result } = renderHook(() => useScrollFollow(2));
  act(() => result.current.onUserGesture("up"));
  assert.equal(result.current.atBottom, false);

  act(() => result.current.onUserGesture("down"));

  assert.equal(result.current.atBottom, false);
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

  assert.equal(result.current.atBottom, false);
  assert.equal(result.current.hasUnseen, true);

  // A deliberate scroll back down to the live edge (a downward gesture ending at the bottom) re-pins
  // and clears the unseen flag.
  act(() => result.current.onUserGesture("down"));
  setScrollElement(result.current.transcriptRef, {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
  });
  act(() => result.current.onScroll());

  assert.equal(result.current.atBottom, true);
  assert.equal(result.current.hasUnseen, false);
});

test("scrollToBottom re-pins and increments the request id", () => {
  const { result } = renderHook(() => useScrollFollow(2));
  act(() => result.current.onUserGesture("up"));
  assert.equal(result.current.atBottom, false);

  act(() => result.current.scrollToBottom());

  assert.equal(result.current.atBottom, true);
  assert.equal(result.current.bottomRequestId, 1);
});

test("pinToBottom re-pins on submit", () => {
  const { result } = renderHook(() => useScrollFollow(2));
  act(() => result.current.onUserGesture("up"));
  assert.equal(result.current.atBottom, false);

  act(() => result.current.pinToBottom());

  assert.equal(result.current.atBottom, true);
});
