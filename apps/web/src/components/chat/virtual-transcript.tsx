import { elementScroll, type Rect, useVirtualizer } from "@tanstack/react-virtual";
import type { ArtifactRef } from "@trevor/session";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isCompactEligible } from "@/components/chat/compact-display";
import { compactLeadingGaps } from "@/components/chat/compact-spacing";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import { cn } from "@/lib/utils";
import { atBottomOf, liveEdgeOffset } from "@/scroll";
import type { ScrollFollowController, ScrollWriter } from "@/scroll-follow";
import type { Message } from "../../transcript";
import { type TranscriptRow, transcriptRowKey } from "../../transcript-rows";

/**
 * The per-row rendering config a transcript row needs: which row-level takeovers/commands its buttons
 * fire, and the two display flags (thinking visibility, compact layout). Grouped as one value so it
 * travels PanelHost -> VirtualTranscript as a single prop instead of seven mirrored ones, and its shape
 * is declared once (the panel's TranscriptView embeds the same bundle).
 */
export interface TranscriptRowConfig {
  readonly showThinking: boolean;
  readonly onOpenPath: (path: string) => void;
  readonly onOpenArtifact?: (artifact: ArtifactRef) => void;
  readonly onDoctorRefresh: () => void;
  readonly onMenuAction?: (command: string, args: string) => void;
  /** Opens the tool detail takeover for a detail-eligible row (plan 08). */
  readonly onOpenDetail?: (message: Message) => void;
  /** Opens the inline-agent detail takeover for a child session (plan 09.4 M6). */
  readonly onOpenAgent?: (childSessionId: string) => void;
  /** Compact transcript mode (plan 05): non-primary rows collapse to one line. Off by default. */
  readonly compact?: boolean;
}

export interface VirtualTranscriptProps {
  readonly rows: readonly TranscriptRow[];
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  /** The single follow authority (plan 12.2). Every programmatic scroll write asks it, and it decides
   *  synchronously - so a follow can never win a race against a user gesture the way lagging state did.
   *  Pin state is derived from it here too (no separately drilled prop that could disagree). */
  readonly controller: ScrollFollowController;
  readonly scrollToBottomRequest: number;
  readonly rowConfig: TranscriptRowConfig;
  readonly testInitialRect?: Rect;
}

function estimateRowSize(
  row: TranscriptRow | undefined,
  compact: boolean,
  expandedRows: ReadonlySet<string>,
): number {
  // A momentary out-of-range index (the virtualizer can ask before `rows` settles) gets a small
  // neutral estimate; measureElement corrects the real row once it mounts.
  if (!row) {
    return 32;
  }
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

// The compact-mode trailing gap after a row (plan 58): rows sharing a type key sit flush (`pb-1`); a
// type change opens exactly one blank line (`pb-6`). The px values mirror those Tailwind classes, and
// `COMPACT_GAP_DELTA` is the extra height a gap-opening row adds to its size estimate so the pre-measure
// layout tracks the rendered padding - kept arithmetic so it can't silently drift from the classes.
const COMPACT_GAP_PB = "pb-6";
const COMPACT_FLUSH_PB = "pb-1";
const COMPACT_GAP_PX = 24;
const COMPACT_FLUSH_PX = 4;
const COMPACT_GAP_DELTA = COMPACT_GAP_PX - COMPACT_FLUSH_PX;

export function VirtualTranscript({
  rows,
  scrollRef,
  controller,
  scrollToBottomRequest,
  rowConfig,
  testInitialRect,
}: VirtualTranscriptProps) {
  const {
    showThinking,
    onOpenPath,
    onOpenArtifact,
    onDoctorRefresh,
    onMenuAction,
    onOpenDetail,
    onOpenAgent,
    compact = false,
  } = rowConfig;
  const lastRowIdRef = useRef<string | null>(null);
  const [readyToReveal, setReadyToReveal] = useState(false);
  const [settleTick, setSettleTick] = useState(0);
  // The controller's pin state, mirrored into render: the same value the adapter's jump button reads,
  // derived here (not drilled as a prop) so a remount or a lagging parent render can never disagree
  // with the authority. Effects re-run when it flips; write-time decisions still ask the controller.
  const pinned = useSyncExternalStore(
    controller.subscribe,
    controller.isPinned,
    controller.isPinned,
  );
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
  // The per-row leading-gap flags for compact mode (plan 58): `compactGaps[i]` is true when row `i` is a
  // different type than row `i - 1`, so the gap AFTER row `i` is `compactGaps[i + 1]`. Null outside
  // compact mode (the historical spacing applies then). Derived once per rows change.
  const compactGaps = useMemo(() => (compact ? compactLeadingGaps(rows) : null), [compact, rows]);
  // A row's content estimate plus its compact trailing gap (see `padClass` below). Not memoized: `rows`
  // and `compactGaps` change every render (a new array per streamed token), so a `useCallback` here
  // would rebuild every render anyway - the same shape the prior inline estimator had.
  const estimateWithGap = (index: number): number => {
    const base = estimateRowSize(rows[index], compact, expandedRows);
    return compactGaps?.[index + 1] ? base + COMPACT_GAP_DELTA : base;
  };
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateWithGap,
    getItemKey: (index) => {
      const row = rows[index];
      return row ? transcriptRowKey(row) : `missing:${index}`;
    },
    // --- non-default virtualizer options, each justified for scroll stability (02.8 audit) ---
    // overscan: render 10 rows beyond the viewport each way so a normal wheel/trackpad flick lands on
    // already-measured rows (no estimate-correction nudge as they scroll into view).
    overscan: 10,
    // anchorTo: while pinned, anchor measurement corrections to the END (the live edge we follow);
    // while unpinned, anchor to the START of the visible range so a measured-size change keeps the
    // user's topmost visible row put instead of shifting it (this IS the anchor-compensation the
    // controller allows while unpinned - see scrollToFn).
    anchorTo: pinned ? "end" : "start",
    // followOnAppend is OFF: append-follow policy lives in the controller-gated last-row layout effect
    // below, not in tanstack (D-007). Leaving it "auto" would let tanstack scroll to an appended row
    // through scrollToFn indistinguishably from an anchor correction, defeating the arbitration.
    followOnAppend: false,
    // The virtualizer reads initialOffset only at mount, so compute the estimated total lazily HERE
    // rather than as a live memo that the streaming `rows` would otherwise recompute every token.
    initialOffset: () => {
      if (!pinned) {
        return 0;
      }
      const total = rows.reduce((sum, _row, index) => sum + estimateWithGap(index), 0);
      return Math.max(0, total - (testInitialRect?.height ?? 0));
    },
    initialRect: testInitialRect,
    scrollEndThreshold: 40,
    // useAnimationFrameWithResizeObserver: batch row re-measurement to an animation frame so a row
    // resizing mid-stream coalesces its corrections instead of thrashing scrollTop per layout tick.
    useAnimationFrameWithResizeObserver: true,
    // Every tanstack-initiated scroll is a dumb "ask the controller" pass-through: pinned means it is
    // a follow write, unpinned means it can only be a measure/anchor correction (followOnAppend is off
    // and app follows are gated upstream). ALL policy - denying follows while unpinned, rejecting an
    // unpinned "correction" that would land at the live edge (a lagging-`anchorTo` follow in disguise),
    // and self-write bookkeeping - lives in the controller. Geometry rides along as flat scalars so the
    // controller can make those calls without this hot path allocating a geometry literal per re-measure.
    scrollToFn: (offset, opts, instance) => {
      const element = instance.scrollElement;
      const decision = controller.requestWrite(
        controller.isPinned() ? "follow" : "anchor-compensation",
        element
          ? {
              writer: "virtualizer",
              resultingOffset: offset,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
            }
          : { writer: "virtualizer", resultingOffset: offset },
      );
      if (decision.allowed) {
        elementScroll(offset, opts, instance);
      }
    },
  });

  const scrollToLiveEdge = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (rows.length === 0) {
        return;
      }
      // One write: scrollToEnd routes through scrollToFn (the controller-arbitrated seam). The old
      // second direct `scrollElement.scrollTo(scrollHeight)` chaser is gone - estimate-vs-DOM drift is
      // already corrected by the settle loop and the double-rAF re-follow, both of which re-ask here.
      virtualizer.scrollToEnd({ behavior });
    },
    [rows.length, virtualizer],
  );

  // Every AUTO-follow asks the controller at FIRE time (synchronously), so a follow scheduled a frame
  // ago becomes a no-op if the user has since scrolled away - the one gate that keeps manual upward
  // scrolling from being fought (D-001), now owned by the controller instead of a lagging ref. The
  // `writer` label names which effect asked, for the controller's dev-only denied-write log. Explicit
  // jump-to-bottom (`scrollToBottomRequest`) stays on `scrollToLiveEdge` - it re-pins first.
  const followLiveEdge = useCallback(
    (writer: ScrollWriter, behavior: ScrollBehavior = "auto") => {
      const scrollElement = scrollRef.current;
      const decision = scrollElement
        ? controller.requestWrite("follow", {
            writer,
            resultingOffset: liveEdgeOffset(scrollElement),
            scrollHeight: scrollElement.scrollHeight,
            clientHeight: scrollElement.clientHeight,
          })
        : controller.requestWrite("follow", { writer });
      if (decision.allowed) {
        scrollToLiveEdge(behavior);
      }
    },
    [controller, scrollRef, scrollToLiveEdge],
  );
  const totalSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    const last = rows.at(-1)?.id ?? null;
    if (last !== lastRowIdRef.current) {
      followLiveEdge("append");
    }
    lastRowIdRef.current = last;
  });

  useEffect(() => {
    if (!pinned) {
      return;
    }
    const frame = requestAnimationFrame(() => followLiveEdge("pinned-change"));
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
        // Terminate the settle loop on user intent: if the user scrolled up (unpinned) mid-settle,
        // reveal where they are instead of force-scrolling them back to the edge.
        if (!controller.isPinned()) {
          setReadyToReveal(true);
          return;
        }
        const scrollElement = scrollRef.current;
        const settledAtEdge = scrollElement
          ? atBottomOf({
              scrollHeight: scrollElement.scrollHeight,
              clientHeight: scrollElement.clientHeight,
              scrollTop: scrollElement.scrollTop,
            })
          : false;
        const currentLastIndex = virtualizer.getVirtualItems().at(-1)?.index;
        if (currentLastIndex === rows.length - 1 && settledAtEdge) {
          setReadyToReveal(true);
          return;
        }
        followLiveEdge("settle-loop");
        setSettleTick((tick) => tick + 1);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [
    pinned,
    readyToReveal,
    rows.length,
    scrollRef,
    followLiveEdge,
    controller,
    settleTick,
    virtualizer,
  ]);

  useEffect(() => {
    if (!readyToReveal) {
      return;
    }
    if (!pinned) {
      return;
    }
    const frame = requestAnimationFrame(() => followLiveEdge("post-ready"));
    return () => cancelAnimationFrame(frame);
  }, [pinned, readyToReveal, followLiveEdge]);

  // A measured-size growth (totalSize change) while pinned + streaming follows the live edge. The
  // double rAF lets the virtualizer settle the new measurement before the second snap. Both frames
  // ask the controller, so if the user scrolled away between this layout effect and the frames firing,
  // the follow is denied rather than yanking them back down (this was the constant streaming "tug").
  useLayoutEffect(() => {
    void totalSize;
    if (!readyToReveal || !pinned) {
      return;
    }
    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      followLiveEdge("total-size");
      secondFrame = requestAnimationFrame(() => followLiveEdge("total-size"));
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
        // The bottom gap after this row. In compact mode it is TYPE-AWARE (plan 58): a run of same-type
        // rows sits flush (`pb-1`) and a type change opens exactly one blank line (`pb-6`), driven by
        // `compactLeadingGaps` - so read-only tools group, same-name tools group, and MCP/other types
        // each separate. Outside compact mode the historical spacing holds: a full gap, tightened only
        // for the existing consecutive read-only tool case (`compactAbove`).
        const padClass = compact
          ? compactGaps?.[item.index + 1]
            ? COMPACT_GAP_PB
            : COMPACT_FLUSH_PB
          : row.kind === "message" && row.compactAbove
            ? "pb-2"
            : "pb-8";
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            data-transcript-virtual-row={row.kind}
            className={cn("absolute top-0 left-0 flow-root w-full", padClass)}
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <TranscriptRowView
              onMenuAction={onMenuAction}
              row={row}
              showThinking={showThinking}
              onOpenPath={onOpenPath}
              onOpenArtifact={onOpenArtifact}
              onDoctorRefresh={onDoctorRefresh}
              compact={compact}
              expandedRows={expandedRows}
              onToggleRow={toggleRow}
              onOpenDetail={onOpenDetail}
              onOpenAgent={onOpenAgent}
            />
          </div>
        );
      })}
    </div>
  );
}
