import { type ReactNode, useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { JumpToBottom } from "@/components/chat/jump-to-bottom";
import type { ScrollFollow } from "@/hooks/use-scroll-follow";
import { cn } from "@/lib/utils";
import { liveEdgeOffset } from "@/scroll";

const ANCHOR_EPSILON_PX = 1.5;
const DEFAULT_ITEM_SELECTOR = "[data-live-scroll-item]";

interface VisualAnchorSnapshot {
  readonly id: string;
  readonly top: number;
}

export interface LiveScrollSurfaceProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly itemSelector?: string;
  readonly revision: number | string;
  readonly scroll: ScrollFollow;
  readonly surfaceLabel?: string;
  readonly viewportDataAttribute?: string;
}

function visibleAnchorIn(
  scrollElement: HTMLElement | null,
  itemSelector: string,
): VisualAnchorSnapshot | null {
  if (!scrollElement) {
    return null;
  }
  const scrollRect = scrollElement.getBoundingClientRect();
  const items = Array.from(scrollElement.querySelectorAll<HTMLElement>(itemSelector));
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const top = rect.top - scrollRect.top;
    if (rect.bottom <= scrollRect.top || rect.top >= scrollRect.bottom) {
      continue;
    }
    if (top < 24 || top > scrollElement.clientHeight - 80) {
      continue;
    }
    const id = item.dataset.liveScrollItemId;
    if (id) {
      return { id, top };
    }
  }
  return null;
}

function anchorTop(scrollElement: HTMLElement, itemSelector: string, id: string): number | null {
  const item = Array.from(scrollElement.querySelectorAll<HTMLElement>(itemSelector)).find(
    (candidate) => candidate.dataset.liveScrollItemId === id,
  );
  if (!item) {
    return null;
  }
  const scrollRect = scrollElement.getBoundingClientRect();
  return item.getBoundingClientRect().top - scrollRect.top;
}

function setScrollTop(element: HTMLElement, top: number): void {
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ top, behavior: "auto" });
    return;
  }
  element.scrollTop = top;
}

/**
 * Shared non-virtual live-output scroller. It reuses the main transcript's `ScrollFollow` authority:
 * follow writes run only while pinned, explicit jumps re-pin, and unpinned updates preserve the reader's
 * visual anchor instead of letting appended or streaming output push the viewport around.
 */
export function LiveScrollSurface(props: LiveScrollSurfaceProps) {
  const {
    children,
    className,
    itemSelector = DEFAULT_ITEM_SELECTOR,
    revision,
    scroll,
    surfaceLabel = "live output",
    viewportDataAttribute,
  } = props;
  const previousRevisionRef = useRef<number | string | null>(null);
  const previousScrollTopRef = useRef<number | null>(null);
  const visualAnchorRef = useRef<VisualAnchorSnapshot | null>(null);

  // The adapter no longer mirrors these into its owner's render (Tier 2.4), so this surface
  // subscribes itself: a pin flip must re-run the anchor-snapshot layout effect below (it decides
  // follow-vs-compensate and where to snapshot from), and a bottom request drives the jump effect.
  // Re-rendering here is cheap - `children` keeps identity, so React bails out of the subtree.
  const atBottom = useSyncExternalStore(
    scroll.controller.subscribe,
    scroll.controller.isPinned,
    scroll.controller.isPinned,
  );
  const bottomRequestId = useSyncExternalStore(
    scroll.ui.subscribe,
    scroll.ui.bottomRequestId,
    scroll.ui.bottomRequestId,
  );

  const scrollToLiveEdge = useCallback(() => {
    const element = scroll.transcriptRef.current;
    if (!element || element.scrollHeight <= element.clientHeight) {
      return;
    }
    const top = liveEdgeOffset({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    });
    const decision = scroll.controller.requestWrite("follow", {
      writer: "append",
      resultingOffset: top,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    });
    if (decision.allowed) {
      setScrollTop(element, top);
    }
  }, [scroll.controller, scroll.transcriptRef]);

  useLayoutEffect(() => {
    const element = scroll.transcriptRef.current;
    const previousRevision = previousRevisionRef.current;
    const contentChanged = previousRevision !== null && previousRevision !== revision;

    if (element && previousRevision === null && atBottom) {
      scrollToLiveEdge();
    } else if (element && contentChanged) {
      if (atBottom) {
        scrollToLiveEdge();
      } else {
        const previousAnchor = visualAnchorRef.current;
        let nextTop: number | null = null;
        if (previousAnchor) {
          const currentTop = anchorTop(element, itemSelector, previousAnchor.id);
          if (currentTop !== null) {
            const delta = currentTop - previousAnchor.top;
            if (Math.abs(delta) > ANCHOR_EPSILON_PX) {
              nextTop = element.scrollTop + delta;
            }
          }
        } else if (
          previousScrollTopRef.current !== null &&
          Math.abs(element.scrollTop - previousScrollTopRef.current) > ANCHOR_EPSILON_PX
        ) {
          nextTop = previousScrollTopRef.current;
        }

        if (nextTop !== null) {
          const decision = scroll.controller.requestWrite("anchor-compensation", {
            writer: "append",
            resultingOffset: nextTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          });
          if (decision.allowed) {
            setScrollTop(element, nextTop);
          }
        }
      }
    }

    visualAnchorRef.current = atBottom ? null : visibleAnchorIn(element, itemSelector);
    previousScrollTopRef.current = element?.scrollTop ?? null;
    previousRevisionRef.current = revision;
  });

  useLayoutEffect(() => {
    if (bottomRequestId === 0) {
      return;
    }
    scrollToLiveEdge();
  }, [bottomRequestId, scrollToLiveEdge]);

  const viewportData = viewportDataAttribute ? { [viewportDataAttribute]: "" } : {};

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-live-scroll-surface={surfaceLabel}>
      <div
        {...viewportData}
        ref={scroll.transcriptRef}
        onScroll={scroll.onScroll}
        onWheel={(event) => {
          if (event.deltaY !== 0) {
            scroll.onUserGesture(event.deltaY < 0 ? "up" : "down");
          }
        }}
        data-live-scroll-viewport
        data-live-scroll-pinned={atBottom ? "true" : "false"}
        className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}
      >
        {children}
      </div>
      {/* The shared jump-to-bottom leaf (Tier 2.4): it owns its pin/unseen subscriptions. */}
      <JumpToBottom controller={scroll.controller} ui={scroll.ui} onJump={scroll.scrollToBottom} />
    </div>
  );
}
