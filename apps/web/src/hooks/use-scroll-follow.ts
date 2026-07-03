import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createScrollFollowController, type ScrollFollowController } from "@/scroll-follow";

/**
 * The React adapter over the follow controller (plan 12.2). It owns NO pin policy - that lives in the
 * pure `scroll-follow.ts` state machine. Its jobs are React-shaped only: keep the controller instance
 * stable across renders and remounts, mirror the (synchronous) pin state into render via
 * `useSyncExternalStore` so the jump button tracks it, translate DOM events into controller calls, and
 * derive the unseen-content flag. The controller is handed down to `VirtualTranscript` so its scroll
 * writes ask the SAME authority the jump button reads.
 */
export interface ScrollFollow {
  readonly transcriptRef: React.RefObject<HTMLDivElement | null>;
  /** The single follow authority, threaded to VirtualTranscript so its writes route through it. */
  readonly controller: ScrollFollowController;
  /** True while following the live edge (= the controller is pinned). Drives the jump affordance. */
  readonly atBottom: boolean;
  readonly hasUnseen: boolean;
  readonly bottomRequestId: number;
  /** A scroll event on the container: hands the current geometry to the controller. */
  readonly onScroll: () => void;
  /** A directional user gesture (wheel `deltaY` sign, touch-move delta). Upward unpins synchronously. */
  readonly onUserGesture: (direction: "up" | "down") => void;
  /** Jump-to-bottom affordance: re-pin and request an explicit scroll to the live edge. */
  readonly scrollToBottom: () => void;
  /** Prompt submit / shell / command: re-pin so the turn's output is followed. */
  readonly pinToBottom: () => void;
}

export function useScrollFollow(itemCount: number): ScrollFollow {
  const transcriptRef = useRef<HTMLDivElement>(null);

  // One controller for the lifetime of the composition root - stable across every VirtualTranscript
  // remount (the connecting / waiting branch swaps), so pin state is never minted fresh underneath us.
  const controllerRef = useRef<ScrollFollowController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createScrollFollowController();
  }
  const controller = controllerRef.current;

  // The pin state is owned by the controller (mutated synchronously outside React); mirror it into
  // render so the jump button re-renders exactly when it flips.
  const atBottom = useSyncExternalStore(
    controller.subscribe,
    controller.isPinned,
    controller.isPinned,
  );

  const [bottomRequestId, setBottomRequestId] = useState(0);
  const [hasUnseen, setHasUnseen] = useState(false);
  const seenCountRef = useRef(itemCount);

  const onScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) {
      return;
    }
    controller.scrolled({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    });
  }, [controller]);

  const onUserGesture = useCallback(
    (direction: "up" | "down") => {
      controller.gesture(direction);
    },
    [controller],
  );

  const scrollToBottom = useCallback(() => {
    controller.repin("jump");
    // Bump the explicit request id so VirtualTranscript scrolls to the live edge NOW (the re-pin alone
    // only re-enables follow; the jump affordance means "take me there").
    setBottomRequestId((id) => id + 1);
  }, [controller]);

  const pinToBottom = useCallback(() => {
    controller.repin("submit");
  }, [controller]);

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
    controller,
    atBottom,
    hasUnseen,
    bottomRequestId,
    onScroll,
    onUserGesture,
    scrollToBottom,
    pinToBottom,
  };
}
