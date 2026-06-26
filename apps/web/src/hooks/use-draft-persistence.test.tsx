import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { readDraft, writeDraft } from "@/composer-storage";
import { useDraftPersistence } from "./use-draft-persistence";

/**
 * Draft persistence (D-083): restore an unsubmitted draft per tab+session without clobbering a typed
 * draft, debounce writes, clear on empty, isolate by session, and tolerate storage failure. Driven
 * through a tiny harness that owns the draft state the hook reads/writes.
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

const throwingStorage = (): Storage =>
  ({
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
    clear: () => {},
    key: () => null,
    length: 0,
  }) as Storage;

/** Owns the draft state the hook persists, mirroring App's composer wiring. */
function useHarness(opts: {
  storage: Storage;
  tabId: string;
  sessionId: string | null;
  initialDraft?: string;
}) {
  const [draft, setDraft] = useState(opts.initialDraft ?? "");
  useDraftPersistence({
    storage: opts.storage,
    tabId: opts.tabId,
    sessionId: opts.sessionId,
    draft,
    setDraft,
  });
  return { draft, setDraft };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("restores a saved draft once the session id is known", () => {
  const storage = fakeStorage();
  writeDraft(storage, "t", "sess", "saved draft");
  const { result } = renderHook(() => useHarness({ storage, tabId: "t", sessionId: "sess" }));
  assert.equal(result.current.draft, "saved draft");
});

test("does not clobber a non-empty in-memory draft", () => {
  const storage = fakeStorage();
  writeDraft(storage, "t", "sess", "saved draft");
  const { result } = renderHook(() =>
    useHarness({ storage, tabId: "t", sessionId: "sess", initialDraft: "already typing" }),
  );
  assert.equal(result.current.draft, "already typing");
});

test("debounces writes and clears the slot when the draft goes empty", () => {
  const storage = fakeStorage();
  const { result } = renderHook(() => useHarness({ storage, tabId: "t", sessionId: "sess" }));

  act(() => result.current.setDraft("hello"));
  // Not written yet - the write is debounced.
  assert.equal(readDraft(storage, "t", "sess"), "");
  act(() => vi.advanceTimersByTime(300));
  assert.equal(readDraft(storage, "t", "sess"), "hello");

  // Emptying the composer (submit / clear) clears the stored draft after the debounce.
  act(() => result.current.setDraft(""));
  act(() => vi.advanceTimersByTime(300));
  assert.equal(readDraft(storage, "t", "sess"), "");
});

test("drafts are isolated by session id", () => {
  const storage = fakeStorage();
  const { result, rerender } = renderHook(
    ({ sessionId }: { sessionId: string }) => useHarness({ storage, tabId: "t", sessionId }),
    { initialProps: { sessionId: "sessA" } },
  );
  act(() => result.current.setDraft("for A"));
  act(() => vi.advanceTimersByTime(300));

  rerender({ sessionId: "sessB" });
  act(() => result.current.setDraft("for B"));
  act(() => vi.advanceTimersByTime(300));

  assert.equal(readDraft(storage, "t", "sessA"), "for A");
  assert.equal(readDraft(storage, "t", "sessB"), "for B");
});

test("storage failure never breaks typing", () => {
  const storage = throwingStorage();
  const { result } = renderHook(() => useHarness({ storage, tabId: "t", sessionId: "sess" }));
  // Typing + debounce flush must not throw despite the backing storage rejecting every call.
  act(() => result.current.setDraft("hello"));
  act(() => vi.advanceTimersByTime(300));
  assert.equal(result.current.draft, "hello");
});
