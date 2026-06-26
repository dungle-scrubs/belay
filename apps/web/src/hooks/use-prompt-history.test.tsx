import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { test } from "vitest";
import { usePromptHistory } from "./use-prompt-history";

/**
 * Prompt-history recall (D-084): record published prompts, then ArrowUp/ArrowDown walk the ring and
 * the saved draft is restored at the newest end. Driven through the hook in jsdom; the cap + de-dupe
 * policy is covered purely in composer-storage.test.ts.
 */

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

test("ArrowUp walks older, ArrowDown walks newer, and restores the live draft at the end", () => {
  const storage = fakeStorage();
  const { result } = renderHook(() => usePromptHistory({ storage, tabId: "t", sessionId: "sess" }));

  act(() => result.current.record("first"));
  act(() => result.current.record("second"));

  // ArrowUp from the live draft recalls the newest, then progressively older (clamped at oldest).
  let recalled: string | null = null;
  act(() => {
    recalled = result.current.recallPrev("a half-typed draft");
  });
  assert.equal(recalled, "second");
  assert.equal(result.current.navigating, true);
  act(() => {
    recalled = result.current.recallPrev("ignored once navigating");
  });
  assert.equal(recalled, "first");
  act(() => {
    recalled = result.current.recallPrev("still ignored");
  });
  assert.equal(recalled, "first"); // clamped at the oldest

  // ArrowDown walks back toward newer, then past the newest restores the stashed live draft.
  act(() => {
    recalled = result.current.recallNext();
  });
  assert.equal(recalled, "second");
  act(() => {
    recalled = result.current.recallNext();
  });
  assert.equal(recalled, "a half-typed draft");
  assert.equal(result.current.navigating, false);
  // ArrowDown when not navigating is a no-op (null), so the caller leaves the keypress alone.
  act(() => {
    recalled = result.current.recallNext();
  });
  assert.equal(recalled, null);
});

test("recallPrev on an empty ring returns null (nothing to recall)", () => {
  const storage = fakeStorage();
  const { result } = renderHook(() => usePromptHistory({ storage, tabId: "t", sessionId: "sess" }));
  let recalled: string | null = "x";
  act(() => {
    recalled = result.current.recallPrev("draft");
  });
  assert.equal(recalled, null);
  assert.equal(result.current.navigating, false);
});

test("history is isolated by session and reloads from storage", () => {
  const storage = fakeStorage();
  const { result, rerender } = renderHook(
    ({ sessionId }: { sessionId: string }) => usePromptHistory({ storage, tabId: "t", sessionId }),
    { initialProps: { sessionId: "sessA" } },
  );
  act(() => result.current.record("only in A"));

  // Switching sessions resets navigation and loads B's (empty) ring.
  rerender({ sessionId: "sessB" });
  let recalled: string | null = "x";
  act(() => {
    recalled = result.current.recallPrev("draft");
  });
  assert.equal(recalled, null);

  // A fresh hook over the same storage + session reloads A's recorded prompt (reload persistence).
  const reopened = renderHook(() => usePromptHistory({ storage, tabId: "t", sessionId: "sessA" }));
  act(() => {
    recalled = reopened.result.current.recallPrev("draft");
  });
  assert.equal(recalled, "only in A");
});
