import assert from "node:assert/strict";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { readDraft, writeDraft } from "@/composer-storage";
import { createMemoryStorage } from "@/test-support/storage";
import { useDraftPersistence } from "./use-draft-persistence";

/**
 * Draft persistence (D-083): restore an unsubmitted draft per tab+session without clobbering a typed
 * draft, debounce writes, clear on empty, isolate by session, and tolerate storage failure. Driven
 * through a tiny harness that owns the draft state the hook reads/writes.
 */

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
  const storage = createMemoryStorage();
  writeDraft(storage, "t", "sess", "saved draft");
  const { result } = renderHook(() => useHarness({ storage, tabId: "t", sessionId: "sess" }));
  assert.equal(result.current.draft, "saved draft");
});

test("does not clobber a non-empty in-memory draft", () => {
  const storage = createMemoryStorage();
  writeDraft(storage, "t", "sess", "saved draft");
  const { result } = renderHook(() =>
    useHarness({ storage, tabId: "t", sessionId: "sess", initialDraft: "already typing" }),
  );
  assert.equal(result.current.draft, "already typing");
});

test("debounces writes and clears the slot when the draft goes empty", () => {
  const storage = createMemoryStorage();
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
  const storage = createMemoryStorage();
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

test("switching sessions resets the composer, never carrying the prior session's draft over", () => {
  const storage = createMemoryStorage();
  writeDraft(storage, "t", "sessB", "draft for B");
  const { result, rerender } = renderHook(
    ({ sessionId }: { sessionId: string }) => useHarness({ storage, tabId: "t", sessionId }),
    { initialProps: { sessionId: "sessA" } },
  );
  // Leave an unsubmitted half-typed command in session A.
  act(() => result.current.setDraft("/c"));
  act(() => vi.advanceTimersByTime(300));

  // Switch to B: the composer shows B's OWN saved draft, not A's "/c" (no bleed-through).
  act(() => rerender({ sessionId: "sessB" }));
  assert.equal(result.current.draft, "draft for B");

  // Switch to a draftless session: the composer is empty, not "/c" or "draft for B".
  act(() => rerender({ sessionId: "sessC" }));
  assert.equal(result.current.draft, "");
});

test("a stale bare slash-command fragment is never restored and is cleared on visit", () => {
  const storage = createMemoryStorage();
  // Simulate a stale "/c" left in a session's slot by the old draft-carryover bug.
  writeDraft(storage, "t", "sess", "/c");
  const { result } = renderHook(() => useHarness({ storage, tabId: "t", sessionId: "sess" }));
  // The composer opens empty (no "/c", so the command menu never pops on switch)...
  assert.equal(result.current.draft, "");
  // ...and the stale fragment is overwritten with an empty slot after the debounce.
  act(() => vi.advanceTimersByTime(300));
  assert.equal(readDraft(storage, "t", "sess"), "");
});

test("a bare command fragment typed live is not persisted as a draft", () => {
  const storage = createMemoryStorage();
  const { result } = renderHook(() => useHarness({ storage, tabId: "t", sessionId: "sess" }));
  act(() => result.current.setDraft("/c"));
  act(() => vi.advanceTimersByTime(300));
  assert.equal(readDraft(storage, "t", "sess"), "", "a half-typed command is not saved");

  // A real message (or a command with args) still persists normally.
  act(() => result.current.setDraft("/cd ~/dev/x"));
  act(() => vi.advanceTimersByTime(300));
  assert.equal(readDraft(storage, "t", "sess"), "/cd ~/dev/x");
});

test("storage failure never breaks typing", () => {
  const storage = throwingStorage();
  const { result } = renderHook(() => useHarness({ storage, tabId: "t", sessionId: "sess" }));
  // Typing + debounce flush must not throw despite the backing storage rejecting every call.
  act(() => result.current.setDraft("hello"));
  act(() => vi.advanceTimersByTime(300));
  assert.equal(result.current.draft, "hello");
});
