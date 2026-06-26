import { useCallback, useEffect, useRef, useState } from "react";
import { appendHistory, readHistory } from "@/composer-storage";

/**
 * Terminal-style prompt-history recall for the composer (D-084), per tab+session. `record` appends a
 * published prompt (or bang shell command) to the ring; ArrowUp/ArrowDown in the composer drive
 * `recallPrev`/`recallNext`. A recall cursor walks the ring from newest to oldest and back; at the
 * far (newest) end it restores the draft the user had before navigation started.
 *
 *   - recallPrev(draft): step toward OLDER. On the first step it stashes the live draft, then returns
 *     the newest entry; further steps return progressively older entries, clamped at the oldest.
 *     Returns null when the ring is empty (nothing to recall).
 *   - recallNext(): step toward NEWER. Returns the next-newer entry; past the newest it exits
 *     navigation and returns the stashed draft (which may be "" - the empty composer the user started
 *     from). Returns null when not navigating (so the caller leaves the keypress alone).
 */
export interface PromptHistory {
  /** True while the recall cursor is parked in history (ArrowDown is then eligible to step forward). */
  readonly navigating: boolean;
  readonly record: (entry: string) => void;
  readonly recallPrev: (currentDraft: string) => string | null;
  readonly recallNext: () => string | null;
  readonly resetNavigation: () => void;
}

export function usePromptHistory({
  storage,
  tabId,
  sessionId,
}: {
  readonly storage: Storage;
  readonly tabId: string;
  readonly sessionId: string | null;
}): PromptHistory {
  const [items, setItems] = useState<readonly string[]>([]);
  // null = not navigating (the live draft); otherwise an index into `items` (newest = length-1).
  const cursorRef = useRef<number | null>(null);
  // The draft the user had when navigation began, restored when they step back past the newest entry.
  const savedDraftRef = useRef("");
  const [navigating, setNavigating] = useState(false);

  const stopNavigating = useCallback(() => {
    cursorRef.current = null;
    setNavigating(false);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setItems([]);
      stopNavigating();
      return;
    }
    setItems(readHistory(storage, tabId, sessionId));
    stopNavigating();
  }, [sessionId, tabId, storage, stopNavigating]);

  const record = useCallback(
    (entry: string) => {
      if (!sessionId) {
        return;
      }
      setItems(appendHistory(storage, tabId, sessionId, entry));
      stopNavigating();
    },
    [sessionId, tabId, storage, stopNavigating],
  );

  const recallPrev = useCallback(
    (currentDraft: string): string | null => {
      if (items.length === 0) {
        return null;
      }
      if (cursorRef.current === null) {
        savedDraftRef.current = currentDraft;
        cursorRef.current = items.length - 1;
      } else {
        cursorRef.current = Math.max(0, cursorRef.current - 1);
      }
      setNavigating(true);
      return items[cursorRef.current] ?? null;
    },
    [items],
  );

  const recallNext = useCallback((): string | null => {
    if (cursorRef.current === null) {
      return null;
    }
    const next = cursorRef.current + 1;
    if (next >= items.length) {
      stopNavigating();
      return savedDraftRef.current;
    }
    cursorRef.current = next;
    return items[next] ?? null;
  }, [items, stopNavigating]);

  return { navigating, record, recallPrev, recallNext, resetNavigation: stopNavigating };
}
