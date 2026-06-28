import { useCallback, useEffect, useRef, useState } from "react";
import { atBottomOf } from "@/scroll";

export interface ScrollFollow {
  readonly transcriptRef: React.RefObject<HTMLDivElement | null>;
  readonly atBottom: boolean;
  readonly hasUnseen: boolean;
  readonly bottomRequestId: number;
  readonly onScroll: () => void;
  readonly onUserScrollIntent: () => void;
  readonly scrollToBottom: () => void;
  readonly pinToBottom: () => void;
}

export function useScrollFollow(itemCount: number): ScrollFollow {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [bottomRequestId, setBottomRequestId] = useState(0);
  const [hasUnseen, setHasUnseen] = useState(false);

  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;
  const userScrollIntentUntilRef = useRef(0);
  const seenCountRef = useRef(itemCount);

  const pinToBottom = useCallback(() => {
    setAtBottom(true);
  }, []);

  const onUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = performance.now() + 700;
    const el = transcriptRef.current;
    if (el && !atBottomOf(el)) {
      setAtBottom(false);
    }
  }, []);

  const onScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) {
      return;
    }
    if (atBottomOf(el)) {
      setAtBottom(true);
      return;
    }
    const userIsScrolling = performance.now() <= userScrollIntentUntilRef.current;
    if (userIsScrolling || !atBottomRef.current) {
      setAtBottom(false);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    setAtBottom(true);
    userScrollIntentUntilRef.current = 0;
    setBottomRequestId((id) => id + 1);
  }, []);

  useEffect(() => {
    if (atBottom) {
      seenCountRef.current = itemCount;
      setHasUnseen(false);
    } else if (itemCount > seenCountRef.current) {
      setHasUnseen(true);
    }
  }, [atBottom, itemCount]);

  return {
    transcriptRef,
    atBottom,
    hasUnseen,
    bottomRequestId,
    onScroll,
    onUserScrollIntent,
    scrollToBottom,
    pinToBottom,
  };
}
