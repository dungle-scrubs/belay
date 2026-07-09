import {
  defaultRangeExtractor,
  elementScroll,
  type Rect,
  useVirtualizer,
} from "@tanstack/react-virtual";
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
import { compactLeadingGaps } from "@/components/chat/compact-spacing";
import { TranscriptRowView } from "@/components/chat/transcript-row-view";
import {
  buildTranscriptTurns,
  COMPACT_FLUSH_PB,
  COMPACT_GAP_PB,
  estimateTranscriptTurnSize,
  transcriptTurnKey,
} from "@/components/chat/transcript-turns";
import { cn } from "@/lib/utils";
import { atBottomOf } from "@/scroll";
import type { ScrollFollowController } from "@/scroll-follow";
import type { Message } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";

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

function repeatsPreviousTool(row: TranscriptRow, previous: TranscriptRow | undefined): boolean {
  return (
    row.kind === "message" &&
    previous?.kind === "message" &&
    row.message.kind === "tool" &&
    previous.message.kind === "tool" &&
    row.message.name === previous.message.name
  );
}

function isAdjacentToolPair(row: TranscriptRow, next: TranscriptRow | undefined): boolean {
  return (
    row.kind === "message" &&
    next?.kind === "message" &&
    row.message.kind === "tool" &&
    next.message.kind === "tool"
  );
}

const ANCHOR_EPSILON_PX = 1.5;
const FULL_RENDER_TURN_LIMIT = 64;

interface VisualAnchorSnapshot {
  readonly id: string;
  readonly top: number;
}

function visibleAnchorIn(scrollElement: HTMLElement | null): VisualAnchorSnapshot | null {
  if (!scrollElement) {
    return null;
  }
  const scrollRect = scrollElement.getBoundingClientRect();
  const rows = Array.from(
    scrollElement.querySelectorAll<HTMLElement>("[data-transcript-virtual-row]"),
  );
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const top = rect.top - scrollRect.top;
    if (rect.bottom <= scrollRect.top || rect.top >= scrollRect.bottom) {
      continue;
    }
    if (top < 40 || top > scrollElement.clientHeight - 120) {
      continue;
    }
    const message = row.querySelector<HTMLElement>("[data-message-id]");
    const id = message?.dataset.messageId;
    if (id) {
      return { id, top };
    }
  }
  return null;
}

function anchorTop(scrollElement: HTMLElement, id: string): number | null {
  const row = Array.from(
    scrollElement.querySelectorAll<HTMLElement>("[data-transcript-virtual-row]"),
  ).find(
    (candidate) =>
      candidate.querySelector<HTMLElement>("[data-message-id]")?.dataset.messageId === id,
  );
  if (!row) {
    return null;
  }
  const scrollRect = scrollElement.getBoundingClientRect();
  return row.getBoundingClientRect().top - scrollRect.top;
}

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
  const previousRowsRef = useRef<readonly TranscriptRow[] | null>(null);
  const previousScrollTopRef = useRef<number | null>(null);
  const previousTotalSizeRef = useRef<number | null>(null);
  const rowsChangedUntilRef = useRef(0);
  const visualAnchorRef = useRef<VisualAnchorSnapshot | null>(null);
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
  const turns = useMemo(() => buildTranscriptTurns(rows), [rows]);
  // A turn's content estimate plus its rows' compact trailing gaps (see `rowPadClass` below). Not
  // memoized: streamed tokens rebuild the rows array, so a callback would rebuild every render anyway.
  const estimateTurn = (index: number): number =>
    estimateTranscriptTurnSize(turns[index], compact, expandedRows, compactGaps);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateTurn,
    rangeExtractor: (range) =>
      turns.length <= FULL_RENDER_TURN_LIMIT
        ? Array.from({ length: turns.length }, (_value, index) => index)
        : defaultRangeExtractor(range),
    getItemKey: (index) => {
      const turn = turns[index];
      return turn ? transcriptTurnKey(turn) : `missing:${index}`;
    },
    // --- non-default virtualizer options, each justified for scroll stability (02.8 audit) ---
    // overscan: render 40 turns beyond the viewport each way so a normal wheel/trackpad flick lands on
    // already-measured rows (no estimate-correction nudge as they scroll into view).
    overscan: 40,
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
      const total = turns.reduce((sum, _turn, index) => sum + estimateTurn(index), 0);
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
      const writeClass = controller.isPinned() ? "follow" : "anchor-compensation";
      if (writeClass === "anchor-compensation" && performance.now() < rowsChangedUntilRef.current) {
        return;
      }
      const decision = controller.requestWrite(
        writeClass,
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

  const scrollElementToLiveEdge = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const element = scrollRef.current;
      if (!element) {
        return;
      }
      const offset = Math.max(0, element.scrollHeight - element.clientHeight);
      const decision = controller.requestWrite("follow", {
        writer: "virtualizer",
        resultingOffset: offset,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      });
      if (decision.allowed) {
        element.scrollTo({ top: offset, behavior });
      }
    },
    [controller, scrollRef],
  );

  const scrollToLiveEdge = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (turns.length === 0) {
        return;
      }
      // Two controller-approved writes: first let TanStack update its virtual range, then snap the real
      // DOM scroll well to its live edge. Spacer-flow layout means the DOM height, not the virtual total
      // alone, is the authoritative bottom target.
      virtualizer.scrollToEnd({ behavior });
      scrollElementToLiveEdge(behavior);
    },
    [scrollElementToLiveEdge, turns.length, virtualizer],
  );

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }
    let frame: number | null = null;
    const rememberReadingAnchor = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        if (controller.isPinned()) {
          visualAnchorRef.current = null;
          previousScrollTopRef.current = scrollElement.scrollTop;
          return;
        }
        visualAnchorRef.current = visibleAnchorIn(scrollElement);
        previousScrollTopRef.current = scrollElement.scrollTop;
      });
    };
    scrollElement.addEventListener("scroll", rememberReadingAnchor, { passive: true });
    return () => {
      scrollElement.removeEventListener("scroll", rememberReadingAnchor);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [controller, scrollRef]);

  // Every AUTO-follow asks the controller at FIRE time (synchronously), so a follow scheduled a frame
  // ago becomes a no-op if the user has since scrolled away - the one gate that keeps manual upward
  // scrolling from being fought (D-001), now owned by the controller instead of a lagging ref. The
  // `writer` label names which effect asked, for the controller's dev-only denied-write log. Explicit
  // jump-to-bottom (`scrollToBottomRequest`) stays on `scrollToLiveEdge` - it re-pins first.
  const followLiveEdge = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      // Only check the pin gate here - do NOT record a ledger entry. The virtualizer's scrollToFn
      // (called inside scrollToLiveEdge → virtualizer.scrollToEnd) issues the actual scroll and records
      // the real target offset. Recording a predicted offset here that doesn't match the actual scroll
      // target creates a ledger mismatch: the scroll event lands at a different offset, fails to match
      // the ledger, and is misread as user movement (causing an unpin). This was the root cause of the
      // scroll not following when tool-call rows were added (their size estimate is badly wrong until
      // measured, so the virtualizer's scroll target diverged from liveEdgeOffset).
      if (controller.mayFollow()) {
        scrollToLiveEdge(behavior);
      }
    },
    [controller, scrollToLiveEdge],
  );
  const totalSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const previousAnchor = visualAnchorRef.current;
    const previousScrollTop = previousScrollTopRef.current;
    const hadPreviousLayout = previousRowsRef.current !== null;
    const rowsChanged = hadPreviousLayout && previousRowsRef.current !== rows;
    const virtualMeasurementsChanged =
      hadPreviousLayout && previousTotalSizeRef.current !== totalSize;

    let clearLayoutShiftFrame: number | null = null;
    let secondClearLayoutShiftFrame: number | null = null;
    let anchorFrame: number | null = null;
    let secondAnchorFrame: number | null = null;
    if ((rowsChanged || virtualMeasurementsChanged) && pinned) {
      controller.layoutShift();
      clearLayoutShiftFrame = requestAnimationFrame(() => {
        secondClearLayoutShiftFrame = requestAnimationFrame(() => controller.clearLayoutShift());
      });
    }

    if (rowsChanged) {
      rowsChangedUntilRef.current = performance.now() + 120;
    }

    if (rowsChanged && !pinned && scrollElement) {
      const compensateReadingAnchor = () => {
        let nextTop: number | null = null;
        if (previousAnchor) {
          const currentTop = anchorTop(scrollElement, previousAnchor.id);
          if (currentTop !== null) {
            const delta = currentTop - previousAnchor.top;
            if (Math.abs(delta) > ANCHOR_EPSILON_PX) {
              nextTop = scrollElement.scrollTop + delta;
            }
          }
        } else if (
          previousScrollTop !== null &&
          Math.abs(scrollElement.scrollTop - previousScrollTop) > ANCHOR_EPSILON_PX
        ) {
          // A single tall streaming row can fill the viewport, leaving no row-level interior anchor.
          // In that case, preserve the reader's raw offset so appended tokens below do not push the
          // already-visible lines upward.
          nextTop = previousScrollTop;
        }

        if (nextTop !== null) {
          const decision = controller.requestWrite("anchor-compensation", {
            writer: "virtualizer",
            resultingOffset: nextTop,
            scrollHeight: scrollElement.scrollHeight,
            clientHeight: scrollElement.clientHeight,
          });
          if (decision.allowed) {
            scrollElement.scrollTo({ top: nextTop, behavior: "auto" });
          }
        }
      };

      compensateReadingAnchor();
      anchorFrame = requestAnimationFrame(() => {
        compensateReadingAnchor();
        secondAnchorFrame = requestAnimationFrame(compensateReadingAnchor);
      });
    }

    visualAnchorRef.current = pinned ? null : visibleAnchorIn(scrollElement);
    previousRowsRef.current = rows;
    previousScrollTopRef.current = scrollElement?.scrollTop ?? null;
    previousTotalSizeRef.current = totalSize;
    return () => {
      if (clearLayoutShiftFrame !== null) {
        cancelAnimationFrame(clearLayoutShiftFrame);
        controller.clearLayoutShift();
      }
      if (secondClearLayoutShiftFrame !== null) {
        cancelAnimationFrame(secondClearLayoutShiftFrame);
        controller.clearLayoutShift();
      }
      if (anchorFrame !== null) {
        cancelAnimationFrame(anchorFrame);
      }
      if (secondAnchorFrame !== null) {
        cancelAnimationFrame(secondAnchorFrame);
      }
    };
  });

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

  const virtualItems = virtualizer.getVirtualItems();

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
    if (turns.length <= FULL_RENDER_TURN_LIMIT) {
      const frame = requestAnimationFrame(() => setReadyToReveal(true));
      return () => cancelAnimationFrame(frame);
    }
    if (!pinned || turns.length === 0) {
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
        const contentFits = scrollElement
          ? scrollElement.scrollHeight <= scrollElement.clientHeight + ANCHOR_EPSILON_PX
          : false;
        const currentLastIndex =
          turns.length <= FULL_RENDER_TURN_LIMIT
            ? turns.length - 1
            : virtualizer.getVirtualItems().at(-1)?.index;
        if (currentLastIndex === turns.length - 1 && (settledAtEdge || contentFits)) {
          setReadyToReveal(true);
          return;
        }
        followLiveEdge();
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
    turns.length,
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
    const frame = requestAnimationFrame(() => followLiveEdge());
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

  const fullyRendered = turns.length <= FULL_RENDER_TURN_LIMIT;
  const items = fullyRendered
    ? turns.map((turn, index) => ({
        end: 0,
        index,
        key: transcriptTurnKey(turn),
        start: 0,
      }))
    : virtualItems;
  const firstItemStart = fullyRendered ? 0 : (items[0]?.start ?? 0);
  const lastItemEnd = fullyRendered ? totalSize : (items.at(-1)?.end ?? 0);
  const paddingTop = fullyRendered ? 0 : firstItemStart;
  const paddingBottom = fullyRendered ? 0 : Math.max(0, totalSize - lastItemEnd);

  return (
    <div
      className={cn(
        fullyRendered ? undefined : "relative",
        readyToReveal ? "fade-in animate-in duration-150" : "opacity-0",
      )}
      style={{
        height: fullyRendered ? undefined : totalSize,
        overflowAnchor: "none",
      }}
      data-transcript-virtual-list
      data-transcript-ready={readyToReveal ? "true" : "false"}
      data-transcript-row-count={rows.length}
      data-transcript-turn-count={turns.length}
      data-transcript-padding-top={paddingTop}
      data-transcript-padding-bottom={paddingBottom}
    >
      {items.map((item) => {
        const turn = turns[item.index];
        if (!turn) {
          return null;
        }
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            data-transcript-virtual-turn
            className={cn("flow-root w-full", fullyRendered ? undefined : "absolute top-0 left-0")}
            style={{
              overflowAnchor: "none",
              transform: fullyRendered ? undefined : `translateY(${item.start}px)`,
            }}
          >
            {turn.rows.map((row, offset) => {
              const rowIndex = turn.startIndex + offset;
              // The bottom gap after this row. In compact mode it is TYPE-AWARE (plan 58): a run of
              // same-type rows sits flush (`pb-1`) and a type change opens exactly one blank line
              // (`pb-6`), driven by `compactLeadingGaps`. Outside compact mode the historical spacing
              // holds: a full gap, tightened only between adjacent tool rows.
              const rowPadClass = compact
                ? compactGaps?.[rowIndex + 1]
                  ? COMPACT_GAP_PB
                  : COMPACT_FLUSH_PB
                : isAdjacentToolPair(row, rows[rowIndex + 1])
                  ? "pb-2"
                  : "pb-8";
              return (
                <div
                  key={row.id}
                  data-index={rowIndex}
                  data-transcript-virtual-row={row.kind}
                  className={cn("flow-root w-full", rowPadClass)}
                  style={{ overflowAnchor: "none" }}
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
                    suppressCompactPrimary={compact && repeatsPreviousTool(row, rows[rowIndex - 1])}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
