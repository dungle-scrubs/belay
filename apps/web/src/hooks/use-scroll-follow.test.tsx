import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { test } from "vitest";
import { useScrollFollow } from "./use-scroll-follow";

function setScrollElement(
  ref: React.RefObject<HTMLDivElement | null>,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(ref, "current", {
    configurable: true,
    value: geometry as HTMLDivElement,
  });
}

test("unpins only when user scroll intent moves away from the bottom", () => {
  const { result } = renderHook(() => useScrollFollow(2));
  setScrollElement(result.current.transcriptRef, {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 100,
  });

  act(() => result.current.onUserScrollIntent());

  assert.equal(result.current.atBottom, false);
});

test("marks appended content unseen while unpinned and clears it at the bottom", () => {
  const { result, rerender } = renderHook(({ count }) => useScrollFollow(count), {
    initialProps: { count: 2 },
  });
  setScrollElement(result.current.transcriptRef, {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 100,
  });

  act(() => result.current.onUserScrollIntent());
  rerender({ count: 3 });

  assert.equal(result.current.atBottom, false);
  assert.equal(result.current.hasUnseen, true);

  setScrollElement(result.current.transcriptRef, {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
  });
  act(() => result.current.onScroll());

  assert.equal(result.current.atBottom, true);
  assert.equal(result.current.hasUnseen, false);
});

test("scrollToBottom pins and increments the request id", () => {
  const { result } = renderHook(() => useScrollFollow(2));
  setScrollElement(result.current.transcriptRef, {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 100,
  });
  act(() => result.current.onUserScrollIntent());

  act(() => result.current.scrollToBottom());

  assert.equal(result.current.atBottom, true);
  assert.equal(result.current.bottomRequestId, 1);
});
