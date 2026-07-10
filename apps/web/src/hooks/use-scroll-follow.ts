import { useLatest } from "ahooks";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createScrollFollowController, type ScrollFollowController } from "@/scroll-follow";

/**
 * The React adapter over the follow controller (plan 12.2). It owns NO pin policy - that lives in the
 * pure `scroll-follow.ts` state machine. Its jobs are React-shaped only: keep the controller instance
 * stable across renders and remounts, translate DOM events into controller calls, and derive the
 * unseen-content flag. The controller is handed down to `VirtualTranscript` so its scroll writes ask
 * the SAME authority the jump button reads.
 *
 * Tier 2.4: the adapter no longer mirrors ANY of that state into the owning component's render. The
 * pin bit stays subscribable on the controller itself, and the two adapter-owned pieces (unseen flag,
 * explicit bottom-request counter) live in the `ui` store below - so the leaves that actually render
 * or act on them (the JumpToBottom chevron, a surface's bottom-request effect) subscribe with their
 * own `useSyncExternalStore`, and a scroll-state change never re-renders the composition root. Every
 * field of the returned `ScrollFollow` is identity-stable for the lifetime of the owner.
 */

/**
 * The adapter's external UI store: the scroll-follow state that is NOT the controller's pin bit.
 * `hasUnseen` glows the jump chevron when content appended below the fold while scrolled up (D-093);
 * `bottomRequestId` is bumped by each explicit live-edge request (jump click, prompt submit, a pinned
 * container resize) and consumed by the transcript surfaces' scroll-to-edge effects.
 */
export interface ScrollFollowUi {
  /** Subscribe to unseen/bottom-request changes (for a leaf's `useSyncExternalStore`). */
  readonly subscribe: (listener: () => void) => () => void;
  readonly hasUnseen: () => boolean;
  readonly bottomRequestId: () => number;
}

/** The store plus its private mutators - the hook (and tests) write; consumers get only `ui`. */
export interface ScrollFollowUiHandle {
  readonly ui: ScrollFollowUi;
  readonly setHasUnseen: (next: boolean) => void;
  readonly requestBottom: () => void;
}

export function createScrollFollowUi(): ScrollFollowUiHandle {
  let hasUnseen = false;
  let bottomRequestId = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    ui: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      hasUnseen: () => hasUnseen,
      bottomRequestId: () => bottomRequestId,
    },
    setHasUnseen: (next) => {
      if (hasUnseen !== next) {
        hasUnseen = next;
        notify();
      }
    },
    requestBottom: () => {
      bottomRequestId += 1;
      notify();
    },
  };
}

export interface ScrollFollow {
  readonly transcriptRef: React.RefObject<HTMLDivElement | null>;
  /** The single follow authority, threaded to VirtualTranscript so its writes route through it. Pin
   *  state is read by subscribing here (`controller.subscribe` + `isPinned`), never via a prop. */
  readonly controller: ScrollFollowController;
  /** The adapter's unseen/bottom-request store (see {@link ScrollFollowUi}); leaves subscribe. */
  readonly ui: ScrollFollowUi;
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

  // The adapter store, minted once alongside the controller (Tier 2.4). Both live outside React state
  // so mutating them re-renders subscribers only, never the hook's owner.
  const uiRef = useRef<ScrollFollowUiHandle | null>(null);
  if (uiRef.current === null) {
    uiRef.current = createScrollFollowUi();
  }
  const uiHandle = uiRef.current;

  const seenCountRef = useRef(itemCount);
  const itemCountRef = useLatest(itemCount);

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
    uiHandle.requestBottom();
  }, [controller, uiHandle]);

  const pinToBottom = useCallback(() => {
    controller.repin("submit");
    // Submit/steer means "follow what I just sent." If the controller was already logically pinned
    // but the DOM had drifted short of the live edge, re-pin alone is a no-op, so request the same
    // explicit live-edge scroll used by the jump affordance.
    uiHandle.requestBottom();
  }, [controller, uiHandle]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const pendingFrames = new Set<number>();
    const requestPinnedResizeFollow = () => {
      if (!controller.isPinned()) {
        return;
      }
      controller.layoutShift();
      const frame = requestAnimationFrame(() => {
        pendingFrames.delete(frame);
        if (controller.isPinned()) {
          uiHandle.requestBottom();
        }
        const clearFrame = requestAnimationFrame(() => {
          pendingFrames.delete(clearFrame);
          controller.clearLayoutShift();
        });
        pendingFrames.add(clearFrame);
      });
      pendingFrames.add(frame);
    };
    const observer = new ResizeObserver(requestPinnedResizeFollow);
    observer.observe(el);
    return () => {
      observer.disconnect();
      for (const frame of pendingFrames) {
        cancelAnimationFrame(frame);
      }
      controller.clearLayoutShift();
    };
  }, [controller, uiHandle]);

  // The unseen flag's two triggers, mirroring the retired [atBottom, itemCount] effect: content
  // appended while unpinned marks unseen (the owner re-renders per appended item, so the itemCount
  // effect still fires); arriving back at the bottom - by ANY path, observed via the controller's own
  // pin subscription since pin flips no longer re-render the owner - marks everything seen.
  useEffect(() => {
    if (controller.isPinned()) {
      seenCountRef.current = itemCount;
      uiHandle.setHasUnseen(false);
    } else if (itemCount > seenCountRef.current) {
      uiHandle.setHasUnseen(true);
    }
  }, [controller, itemCount, uiHandle]);
  useEffect(
    () =>
      controller.subscribe(() => {
        if (controller.isPinned()) {
          seenCountRef.current = itemCountRef.current;
          uiHandle.setHasUnseen(false);
        }
      }),
    [controller, itemCountRef, uiHandle],
  );

  // Stable container (Tier 2.4): every field is identity-stable (refs, the controller, the ui store,
  // useCallbacks over those), so the `scroll` object PanelHost receives NEVER re-mints - scroll-follow
  // state changes reach the leaves through subscriptions, not through this object.
  return useMemo<ScrollFollow>(
    () => ({
      transcriptRef,
      controller,
      ui: uiHandle.ui,
      onScroll,
      onUserGesture,
      scrollToBottom,
      pinToBottom,
    }),
    [controller, uiHandle, onScroll, onUserGesture, scrollToBottom, pinToBottom],
  );
}
