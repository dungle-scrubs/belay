import { elementScroll, type Rect, useVirtualizer } from "@tanstack/react-virtual";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isCompactEligible } from "@/components/chat/compact-display";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import { cn } from "@/lib/utils";
import { mayAutoFollow } from "@/scroll";
import type { Message } from "../../transcript";
import { type TranscriptRow, transcriptRowKey } from "../../transcript-rows";

export interface VirtualTranscriptProps {
  readonly rows: readonly TranscriptRow[];
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly pinned: boolean;
  readonly scrollToBottomRequest: number;
  readonly showThinking: boolean;
  readonly onOpenPath: (path: string) => void;
  readonly onDoctorRefresh: () => void;
  readonly onMenuAction?: (command: string, args: string) => void;
  /** Opens the tool detail takeover for a detail-eligible row (plan 08). */
  readonly onOpenDetail?: (message: Message) => void;
  /** Compact transcript mode (plan 05): non-primary rows collapse to one line. Off by default. */
  readonly compact?: boolean;
  readonly testInitialRect?: Rect;
}

function estimateRowSize(
  row: TranscriptRow,
  compact: boolean,
  expandedRows: ReadonlySet<string>,
): number {
  // A collapsed compact row is one line (~CompactRow's h-6 = 24px + the row's bottom padding); an
  // expanded one falls through to the full estimate (its detail is the full renderer, then
  // measureElement corrects it anyway).
  if (
    compact &&
    row.kind === "message" &&
    isCompactEligible(row.message) &&
    !expandedRows.has(row.message.id)
  ) {
    return 28;
  }
  if (row.kind === "working") {
    return 32;
  }
  if (row.kind === "tool_batch") {
    return 36 + row.tools.length * 22;
  }
  const message = row.message;
  if (message.kind === "user") {
    return 72;
  }
  if (message.kind === "tool") {
    return message.result ? 144 : 38;
  }
  if (message.kind === "assistant") {
    return Math.max(
      72,
      Math.min(520, 56 + Math.ceil((message.text.length + message.thinking.length) / 52) * 19),
    );
  }
  if (message.kind === "shell" || message.kind === "result") {
    return 120;
  }
  return 76;
}

export function VirtualTranscript({
  rows,
  scrollRef,
  pinned,
  scrollToBottomRequest,
  showThinking,
  onOpenPath,
  onDoctorRefresh,
  onMenuAction,
  onOpenDetail,
  compact = false,
  testInitialRect,
}: VirtualTranscriptProps) {
  const lastRowIdRef = useRef<string | null>(null);
  const [readyToReveal, setReadyToReveal] = useState(false);
  const [settleTick, setSettleTick] = useState(0);
  // Which compacted rows have their detail expanded. Owned here (not per-row) so the state survives a
  // row scrolling out of and back into the virtual window, keyed by message id.
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRow = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }, []);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      estimateRowSize(
        rows[index] ?? { kind: "working", id: "fallback", interruptible: true },
        compact,
        expandedRows,
      ),
    getItemKey: (index) =>
      transcriptRowKey(
        rows[index] ?? { kind: "working", id: `missing:${index}`, interruptible: true },
      ),
    // --- non-default virtualizer options, each justified for scroll stability (02.8 audit) ---
    // overscan: render 10 rows beyond the viewport each way so a normal wheel/trackpad flick lands on
    // already-measured rows (no estimate-correction nudge as they scroll into view).
    overscan: 10,
    // anchorTo: while pinned, anchor measurement corrections to the END (the live edge we follow);
    // while unpinned, anchor to the START of the visible range so a measured-size change keeps the
    // user's topmost visible row put instead of shifting it.
    anchorTo: pinned ? "end" : "start",
    // followOnAppend: let tanstack auto-stick to a newly appended row ONLY while pinned; never while
    // unpinned (an append below the fold must not pull the viewport down).
    followOnAppend: pinned ? "auto" : false,
    // The virtualizer reads initialOffset only at mount, so compute the estimated total lazily HERE
    // rather than as a live memo that the streaming `rows` would otherwise recompute every token.
    initialOffset: () => {
      if (!pinned) {
        return 0;
      }
      const total = rows.reduce((sum, row) => sum + estimateRowSize(row, compact, expandedRows), 0);
      return Math.max(0, total - (testInitialRect?.height ?? 0));
    },
    initialRect: testInitialRect,
    scrollEndThreshold: 40,
    // useAnimationFrameWithResizeObserver: batch row re-measurement to an animation frame so a row
    // resizing mid-stream coalesces its corrections instead of thrashing scrollTop per layout tick.
    useAnimationFrameWithResizeObserver: true,
    // The component owns scrolling: it only follows the live edge when pinned (mayAutoFollow). So when
    // the user has scrolled up (unpinned), swallow EVERY programmatic scroll - including tanstack's
    // resize-adjustment, which otherwise yanks the viewport down as a streaming row grows at its
    // bottom (the row is one big virtualized item whose start sits above the viewport, so bottom
    // growth is misread as top-growth). This keeps the intentional scroll position; manual user
    // scrolling is unaffected (that is the browser, not this fn).
    scrollToFn: (offset, opts, instance) => {
      if (mayAutoFollow(pinned)) {
        elementScroll(offset, opts, instance);
      }
    },
  });

  const scrollToLiveEdge = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (rows.length === 0) {
        return;
      }
      virtualizer.scrollToEnd({ behavior });
      const scrollElement = scrollRef.current;
      if (scrollElement) {
        scrollElement.scrollTo({ top: scrollElement.scrollHeight, behavior });
      }
    },
    [rows.length, scrollRef, virtualizer],
  );

  // The latest pinned state, read at fire time by every AUTO-follow so a follow that was scheduled a
  // frame ago becomes a no-op if the user has since scrolled away (unpinned mid-rAF). This is the one
  // gate that keeps manual upward scrolling from being fought (D-001); the scattered effects below all
  // route through `followLiveEdge` instead of calling `scrollToLiveEdge` directly. Explicit
  // jump-to-bottom (`scrollToBottomRequest`) stays on `scrollToLiveEdge` - it re-pins first.
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const followLiveEdge = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (mayAutoFollow(pinnedRef.current)) {
        scrollToLiveEdge(behavior);
      }
    },
    [scrollToLiveEdge],
  );
  const totalSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    const last = rows.at(-1)?.id ?? null;
    if (last !== lastRowIdRef.current) {
      followLiveEdge();
    }
    lastRowIdRef.current = last;
  });

  useEffect(() => {
    if (!pinned) {
      return;
    }
    const frame = requestAnimationFrame(() => followLiveEdge());
    return () => cancelAnimationFrame(frame);
  }, [pinned, followLiveEdge]);

  const items = virtualizer.getVirtualItems();

  useEffect(() => {
    if (scrollToBottomRequest === 0) {
      return;
    }
    scrollToLiveEdge();
  }, [scrollToBottomRequest, scrollToLiveEdge]);

  useEffect(() => {
    void settleTick;
    if (readyToReveal) {
      return;
    }
    if (!pinned || rows.length === 0) {
      const frame = requestAnimationFrame(() => setReadyToReveal(true));
      return () => cancelAnimationFrame(frame);
    }

    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const scrollElement = scrollRef.current;
        const bottomDelta = scrollElement
          ? scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop
          : Number.POSITIVE_INFINITY;
        const currentLastIndex = virtualizer.getVirtualItems().at(-1)?.index;
        if (currentLastIndex === rows.length - 1 && bottomDelta < 40) {
          setReadyToReveal(true);
          return;
        }
        scrollToLiveEdge();
        setSettleTick((tick) => tick + 1);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [pinned, readyToReveal, rows.length, scrollRef, scrollToLiveEdge, settleTick, virtualizer]);

  useEffect(() => {
    if (!readyToReveal) {
      return;
    }
    if (!pinned) {
      return;
    }
    const frame = requestAnimationFrame(() => followLiveEdge());
    return () => cancelAnimationFrame(frame);
  }, [pinned, readyToReveal, followLiveEdge]);

  // A measured-size growth (totalSize change) while pinned + streaming follows the live edge. The
  // double rAF lets the virtualizer settle the new measurement before the second snap. Both frames
  // route through `followLiveEdge`, so if the user scrolls away between this layout effect and the
  // frames firing, the follow is abandoned rather than yanking them back down.
  useLayoutEffect(() => {
    void totalSize;
    if (!readyToReveal || !pinned) {
      return;
    }
    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      followLiveEdge();
      secondFrame = requestAnimationFrame(() => followLiveEdge());
    });
    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [pinned, readyToReveal, followLiveEdge, totalSize]);

  return (
    <div
      className={cn("relative", readyToReveal ? "fade-in animate-in duration-150" : "opacity-0")}
      style={{ height: virtualizer.getTotalSize() }}
      data-transcript-virtual-list
      data-transcript-ready={readyToReveal ? "true" : "false"}
      data-transcript-row-count={rows.length}
    >
      {items.map((item) => {
        const row = rows[item.index];
        if (!row) {
          return null;
        }
        // Tight spacing for collapsed compact rows (so a compact transcript reads dense, not just
        // stacked one-liners with full gaps) and for the existing consecutive-tool case.
        const tight =
          (compact &&
            row.kind === "message" &&
            isCompactEligible(row.message) &&
            !expandedRows.has(row.message.id)) ||
          (row.kind === "message" && row.compactAbove);
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            data-transcript-virtual-row={row.kind}
            className={cn("absolute top-0 left-0 flow-root w-full", tight ? "pb-2" : "pb-8")}
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <TranscriptRowView
              onMenuAction={onMenuAction}
              row={row}
              showThinking={showThinking}
              onOpenPath={onOpenPath}
              onDoctorRefresh={onDoctorRefresh}
              compact={compact}
              expandedRows={expandedRows}
              onToggleRow={toggleRow}
              onOpenDetail={onOpenDetail}
            />
          </div>
        );
      })}
    </div>
  );
}
