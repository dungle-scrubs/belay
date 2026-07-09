import { ChevronDown } from "lucide-react";
import { type ReactNode, useCallback, useLayoutEffect, useRef } from "react";
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

    if (element && previousRevision === null && scroll.atBottom) {
      scrollToLiveEdge();
    } else if (element && contentChanged) {
      if (scroll.atBottom) {
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

    visualAnchorRef.current = scroll.atBottom ? null : visibleAnchorIn(element, itemSelector);
    previousScrollTopRef.current = element?.scrollTop ?? null;
    previousRevisionRef.current = revision;
  });

  useLayoutEffect(() => {
    if (scroll.bottomRequestId === 0) {
      return;
    }
    scrollToLiveEdge();
  }, [scroll.bottomRequestId, scrollToLiveEdge]);

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
        data-live-scroll-pinned={scroll.atBottom ? "true" : "false"}
        className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}
      >
        {children}
      </div>
      {!scroll.atBottom ? (
        <button
          type="button"
          onClick={scroll.scrollToBottom}
          aria-label={scroll.hasUnseen ? "Scroll to new content" : "Scroll to bottom"}
          data-unseen={scroll.hasUnseen ? "true" : undefined}
          className={cn(
            "absolute bottom-3 left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-md border bg-card shadow-sm transition-colors",
            scroll.hasUnseen
              ? "border-primary text-primary"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          <ChevronDown className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
