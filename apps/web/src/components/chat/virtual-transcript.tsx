import { elementScroll, type Rect, useVirtualizer } from "@tanstack/react-virtual";
import type { ArtifactRef } from "@trevor/session";
import {
  memo,
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
  splitOversizedTurns,
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
  /** Reveal-gate timing (defaults to production values). Tests inject fast values so the fade gate
   *  resolves deterministically without waiting out the real quiet window. */
  readonly revealTiming?: RevealTiming;
}

/**
 * The reveal-gate timing (quiet-window fade): `quietMs` is how long the measured content height must
 * hold steady before the transcript fades in; `floorMs`/`deadlineMs` are the minimum hold and hard cap
 * for ordinary content. The `heavy*` pair replaces them when the near-bottom content carries a
 * debounced heavy renderer (a Mermaid diagram), whose ~350ms render debounce leaves the height flat
 * long enough that the plain quiet window would fade in the gap BEFORE it renders.
 */
export interface RevealTiming {
  readonly quietMs: number;
  readonly floorMs: number;
  readonly deadlineMs: number;
  readonly heavyFloorMs: number;
  readonly heavyDeadlineMs: number;
}

const DEFAULT_REVEAL_TIMING: RevealTiming = {
  quietMs: 120,
  floorMs: 0,
  deadlineMs: 700,
  heavyFloorMs: 500,
  heavyDeadlineMs: 1400,
};

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
/** Full render is decided on TOTAL ROW COUNT (Tier 4.1), not turn count: the old 64-TURN gate let one
 *  turn with hundreds of tool rows disable windowing entirely. 128 rows is the old gate's budget for a
 *  plain user/assistant conversation (64 turns x 2 rows), so ordinary short sessions keep flow layout
 *  exactly as before - but a tool storm now counts its real row weight and virtualizes. */
const FULL_RENDER_ROW_LIMIT = 128;
/** Overscan measured in ROWS, not items (Tier 4.1). The old `overscan: 40` counted whole-turn items -
 *  "40 turns each way" (02.8 audit) - which a tool-storm turn could multiply into hundreds of row
 *  subtrees. The range extractor walks outward until it has ~this many rows pre-rendered on each side,
 *  so a wheel/trackpad flick still lands on measured rows while the mounted row count stays bounded. */
const OVERSCAN_ROWS = 40;
/** How many rows up from the live edge to scan for a debounced heavy renderer (a Mermaid fence). Only
 *  content in the initial bottom viewport can shift the reveal position, so a shallow tail scan is
 *  enough and stays cheap on long transcripts. */
const HEAVY_RENDER_SCAN_ROWS = 24;

/** True when a row carries a debounced heavy renderer whose async settle would jump the layout after
 *  first paint - currently a Mermaid fence in an assistant/user message body. Syntax highlighting and
 *  image decode also settle late, but they land inside the plain quiet window; only Mermaid's render
 *  debounce needs the longer floor. */
function rowHasHeavyRenderer(row: TranscriptRow | undefined): boolean {
  if (row?.kind !== "message") {
    return false;
  }
  const message = row.message;
  if (message.kind !== "assistant" && message.kind !== "user") {
    return false;
  }
  return message.text.includes("```mermaid");
}

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

function VirtualTranscriptImpl({
  rows,
  scrollRef,
  controller,
  scrollToBottomRequest,
  rowConfig,
  testInitialRect,
  revealTiming = DEFAULT_REVEAL_TIMING,
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
  // The fade gate lags readyToReveal (structural settle) by a quiet window on the measured height, so
  // late renderers (Mermaid, hljs, images) settle before the transcript is shown. See the reveal
  // effect below.
  const [revealed, setRevealed] = useState(false);
  const revealStartRef = useRef<number | null>(null);
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
  // The virtual-item unit (Tier 4.1): turns, except oversized ones split into fixed-offset blocks so
  // one tool-storm turn cannot mount hundreds of row subtrees. For normal transcripts blocks === turns
  // (same object identities), so keys and cached measurements are unaffected.
  const blocks = useMemo(() => splitOversizedTurns(turns), [turns]);
  // Whether the initial bottom viewport holds a debounced heavy renderer (a Mermaid diagram): if so
  // the reveal gate below waits a longer floor for its render to land, instead of fading in during the
  // 350ms debounce gap. Scans only the tail (see HEAVY_RENDER_SCAN_ROWS) so it stays cheap.
  const nearBottomHasHeavyRenderer = useMemo(() => {
    for (let i = Math.max(0, rows.length - HEAVY_RENDER_SCAN_ROWS); i < rows.length; i += 1) {
      if (rowHasHeavyRenderer(rows[i])) {
        return true;
      }
    }
    return false;
  }, [rows]);
  // The gate is TOTAL ROW COUNT, not turn count (Tier 4.1): a short transcript renders fully (plain
  // flow layout, no estimate-correction machinery), and anything larger windows - including a single
  // turn holding hundreds of tool rows, which the old turn-count gate rendered whole.
  const fullyRendered = rows.length <= FULL_RENDER_ROW_LIMIT;
  // A block's content estimate plus its rows' compact trailing gaps (see `rowPadClass` below). Not
  // memoized: streamed tokens rebuild the rows array, so a callback would rebuild every render anyway.
  const estimateBlock = (index: number): number =>
    estimateTranscriptTurnSize(blocks[index], compact, expandedRows, compactGaps);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateBlock,
    // Row-budget overscan (Tier 4.1, replacing `overscan: 40` items): extend the visible range until
    // ~OVERSCAN_ROWS rows are pre-rendered on each side. Blocks bound rows-per-item, and this walk
    // bounds items-per-overscan, so the two together cap mounted row subtrees no matter how many tool
    // rows one turn holds - while a flick still lands on already-measured rows (no correction nudge).
    rangeExtractor: (range) => {
      if (fullyRendered) {
        return Array.from({ length: blocks.length }, (_value, index) => index);
      }
      let start = range.startIndex;
      let end = range.endIndex;
      let above = 0;
      while (start > 0 && above < OVERSCAN_ROWS) {
        start -= 1;
        above += blocks[start]?.rows.length ?? 1;
      }
      let below = 0;
      while (end < range.count - 1 && below < OVERSCAN_ROWS) {
        end += 1;
        below += blocks[end]?.rows.length ?? 1;
      }
      return Array.from({ length: end - start + 1 }, (_value, index) => start + index);
    },
    getItemKey: (index) => {
      const block = blocks[index];
      return block ? transcriptTurnKey(block) : `missing:${index}`;
    },
    // --- non-default virtualizer options, each justified for scroll stability (02.8 audit) ---
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
      const total = blocks.reduce((sum, _block, index) => sum + estimateBlock(index), 0);
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
      if (blocks.length === 0) {
        return;
      }
      // Two controller-approved writes: first let TanStack update its virtual range, then snap the real
      // DOM scroll well to its live edge. Spacer-flow layout means the DOM height, not the virtual total
      // alone, is the authoritative bottom target.
      virtualizer.scrollToEnd({ behavior });
      scrollElementToLiveEdge(behavior);
    },
    [scrollElementToLiveEdge, blocks.length, virtualizer],
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

  // Synchronous viewport-WIDTH compensation. A one-shot width change (collapsing the right panel, the
  // sidebar-resize commit) re-wraps the mounted rows in the same layout pass, but the virtualizer
  // re-measures a frame LATER - so the content flashes at the wrong offset for one frame before that
  // async correction lands. This ResizeObserver fires after the synchronous re-wrap and BEFORE paint,
  // so snapping to the live edge (pinned) or holding the reading anchor (unpinned) HERE keeps the
  // viewport steady in the very frame the width changed. Height-only changes (streaming growth, the
  // composer) are left to the existing rAF machinery.
  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || typeof ResizeObserver === "undefined") {
      return;
    }
    let lastWidth = scrollElement.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = scrollElement.clientWidth;
      if (width === lastWidth) {
        return;
      }
      lastWidth = width;
      // Only the UNPINNED (reading) case is handled here. While pinned, the virtualizer's end-anchor
      // owns the bottom, and a synchronous snap on the STALE pre-remeasure geometry would overshoot -
      // so pinned is left to the existing machinery.
      if (controller.isPinned()) {
        return;
      }
      const anchor = visualAnchorRef.current;
      if (!anchor) {
        return;
      }
      const currentTop = anchorTop(scrollElement, anchor.id);
      if (currentTop === null) {
        return;
      }
      const delta = currentTop - anchor.top;
      if (Math.abs(delta) <= ANCHOR_EPSILON_PX) {
        return;
      }
      const nextTop = scrollElement.scrollTop + delta;
      const decision = controller.requestWrite("anchor-compensation", {
        writer: "virtualizer",
        resultingOffset: nextTop,
        scrollHeight: scrollElement.scrollHeight,
        clientHeight: scrollElement.clientHeight,
      });
      if (decision.allowed) {
        scrollElement.scrollTop = nextTop;
      }
    });
    observer.observe(scrollElement);
    return () => observer.disconnect();
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

  // A single-frame follow scheduler: a burst of measured-height changes coalesces into ONE follow
  // correction per animation frame instead of a snap per change. This breaks the widen-resize flicker
  // loop - dragging the column wider re-wraps every row shorter, churning the measured height many
  // times; the pinned follow scrolls to the edge, which mounts more now-shorter rows above whose stale
  // (width-agnostic) estimates snap down, which re-fires the follow. Capping it at one correction per
  // frame makes the transcript TRACK the settling edge smoothly rather than over-correct several times
  // a frame. followLiveEdge still asks the controller at fire time, so a frame that fires after the
  // user scrolls away is a no-op (never a tug).
  const followFrameRef = useRef<number | null>(null);
  const scheduleFollow = useCallback(() => {
    if (followFrameRef.current !== null) {
      return;
    }
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null;
      followLiveEdge();
    });
  }, [followLiveEdge]);
  useEffect(
    () => () => {
      if (followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current);
      }
    },
    [],
  );

  const totalSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const hadPreviousLayout = previousRowsRef.current !== null;
    const rowsChanged = hadPreviousLayout && previousRowsRef.current !== rows;
    const virtualMeasurementsChanged =
      hadPreviousLayout && previousTotalSizeRef.current !== totalSize;
    // Tier 4.2: this effect is dependency-less so it can observe every commit, but its DOM reads
    // (visibleAnchorIn's querySelectorAll + per-row getBoundingClientRect) force a reflow per render.
    // When a commit changed neither the rows identity nor the virtualizer's total size - composer
    // keystrokes, pin flips, config changes - nothing this pass would read has moved, so skip it
    // entirely. The passive scroll listener keeps the reading anchor fresh between changes, and the
    // first layout still falls through to seed the refs and the initial anchor snapshot.
    if (hadPreviousLayout && !rowsChanged && !virtualMeasurementsChanged) {
      return;
    }
    const previousAnchor = visualAnchorRef.current;
    const previousScrollTop = previousScrollTopRef.current;

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

    // Compensate on a pure MEASUREMENT change too (rows identity unchanged), not only on rowsChanged:
    // a one-shot width change - collapsing the right panel, the sidebar resize commit, a Mermaid/image
    // above the fold settling - re-wraps the mounted rows and shifts the reader's anchor. Without this,
    // only the virtualizer's own anchorTo="start" correction runs, and it lands ONE FRAME LATE, so the
    // content visibly jumps to the wrong offset for a frame and then snaps back. Running our synchronous
    // compensation here holds the anchor in the same frame the layout changed.
    if ((rowsChanged || virtualMeasurementsChanged) && !pinned && scrollElement) {
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
    if (fullyRendered) {
      const frame = requestAnimationFrame(() => setReadyToReveal(true));
      return () => cancelAnimationFrame(frame);
    }
    if (!pinned || blocks.length === 0) {
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
        const currentLastIndex = fullyRendered
          ? blocks.length - 1
          : virtualizer.getVirtualItems().at(-1)?.index;
        if (currentLastIndex === blocks.length - 1 && (settledAtEdge || contentFits)) {
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
    fullyRendered,
    blocks.length,
    scrollRef,
    followLiveEdge,
    controller,
    settleTick,
    virtualizer,
  ]);

  // The content-settle reveal gate. readyToReveal above fires at STRUCTURAL settle (the live-edge range
  // mounted + pinned), but several renderers finish LATER and change height - a Mermaid diagram
  // debounces ~350ms then renders async, hljs lazy-loads its engine on the first fence, images decode -
  // so fading in at structural settle shows a first paint that then hops. Hold the fade at opacity 0
  // until the measured height (totalSize) has been QUIET for `quietMs`; by then the late renders have
  // landed and the pinned follow above has re-anchored, so the fade reveals the transcript already at
  // its final position. A near-bottom Mermaid uses a longer floor + cap (its debounce leaves the height
  // flat long enough that the plain quiet window would fade in the render gap). A hard deadline caps the
  // wait so a slow/failed renderer can never hold the transcript hidden. Date.now (not performance.now)
  // keeps the gate deterministic under fake timers.
  useEffect(() => {
    // `totalSize` is the quiet-window signal: this effect must re-run on every measured-height change
    // (a late render growing a row) to restart the quiet timer, even though the body reads the DOM
    // clock rather than the value itself. Same observe-only idiom as the totalSize follow effect below.
    void totalSize;
    if (revealed || !readyToReveal) {
      return;
    }
    if (revealStartRef.current === null) {
      revealStartRef.current = Date.now();
    }
    const elapsed = Date.now() - revealStartRef.current;
    const floor = nearBottomHasHeavyRenderer ? revealTiming.heavyFloorMs : revealTiming.floorMs;
    const deadline = nearBottomHasHeavyRenderer
      ? revealTiming.heavyDeadlineMs
      : revealTiming.deadlineMs;
    if (elapsed >= deadline) {
      setRevealed(true);
      return;
    }
    // Re-runs on every totalSize change, so a late render growing a row restarts the quiet timer; the
    // floor and deadline stay anchored to the first structural settle (revealStartRef).
    const wait = Math.max(
      0,
      Math.min(Math.max(revealTiming.quietMs, floor - elapsed), deadline - elapsed),
    );
    const timer = window.setTimeout(() => setRevealed(true), wait);
    return () => window.clearTimeout(timer);
  }, [readyToReveal, revealed, totalSize, nearBottomHasHeavyRenderer, revealTiming]);

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

  // A measured-size change (totalSize) while pinned follows the live edge, coalesced to one correction
  // per frame via scheduleFollow. During streaming a row grows once and the single follow sticks to the
  // bottom; during a widen-resize the measured height churns many times a frame, and coalescing is what
  // stops the pinned follow from chasing the oscillating edge (the flicker). Deliberately no cleanup
  // cancel here: cancelling and rescheduling on every measurement change is the per-change thrash the
  // scheduler exists to avoid - a stale pending frame is harmless (followLiveEdge asks the controller).
  useLayoutEffect(() => {
    void totalSize;
    if (!readyToReveal || !pinned) {
      return;
    }
    scheduleFollow();
  }, [pinned, readyToReveal, scheduleFollow, totalSize]);

  const items = fullyRendered
    ? blocks.map((block, index) => ({
        end: 0,
        index,
        key: transcriptTurnKey(block),
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
        revealed ? "fade-in animate-in duration-150" : "opacity-0",
      )}
      style={{
        height: fullyRendered ? undefined : totalSize,
        overflowAnchor: "none",
      }}
      data-transcript-virtual-list
      // `ready` now marks the VISIBLE state (structural settle + the quiet-window content settle), so
      // waiters (e2e specs, the perf screenshot) see the transcript as it will actually look, not a
      // pre-Mermaid first paint. `settled` exposes the earlier structural-only signal for diagnostics.
      data-transcript-ready={revealed ? "true" : "false"}
      data-transcript-settled={readyToReveal ? "true" : "false"}
      data-transcript-row-count={rows.length}
      data-transcript-turn-count={turns.length}
      data-transcript-padding-top={paddingTop}
      data-transcript-padding-bottom={paddingBottom}
    >
      {items.map((item) => {
        const block = blocks[item.index];
        if (!block) {
          return null;
        }
        return (
          // One virtual item: a whole turn, or a fixed-offset BLOCK of an oversized turn (Tier 4.1).
          // The attribute name predates blocks and stays `-turn` - tests and browser specs key on it,
          // and the wrapper adds no spacing of its own, so a block boundary has no visual seam.
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
            {block.rows.map((row, offset) => {
              const rowIndex = block.startIndex + offset;
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

/**
 * Memo boundary (Tier 1): every prop is stable across renders that did not change the transcript -
 * `rows` only gets fresh identity when the fold re-ran over new events, `scrollRef`/`controller` are
 * ref-stable for the session, `scrollToBottomRequest` is a counter, and `rowConfig` is App's
 * useMemo'd bundle of useMemoizedFn callbacks + display flags. So App re-renders that carry no new
 * events (the 4s live clock, composer keystrokes, palette/chooser toggles) skip the whole transcript
 * subtree here.
 */
export const VirtualTranscript = memo(VirtualTranscriptImpl);
