import { type Rect, useVirtualizer } from "@tanstack/react-virtual";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConcurrentTool } from "@/components/chat/concurrent-tools";
import { type StopAction, TranscriptRowView } from "@/components/chat/transcript-row-view";
import { cn } from "@/lib/utils";
import type { ToolMessage as ToolMessageData } from "../../transcript";
import { type TranscriptRow, transcriptRowKey } from "../../transcript-rows";

export interface VirtualTranscriptProps {
  readonly rows: readonly TranscriptRow[];
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly pinned: boolean;
  readonly scrollToBottomRequest: number;
  readonly showThinking: boolean;
  readonly toConcurrentTool: (tool: ToolMessageData) => ConcurrentTool;
  readonly onOpenPath: (path: string) => void;
  readonly onDoctorRefresh: () => void;
  readonly onStopAction: (action: StopAction) => void;
  readonly testInitialRect?: Rect;
}

function estimateRowSize(row: TranscriptRow): number {
  if (row.kind === "queue") {
    return 48 + row.queue.length * 28;
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
  toConcurrentTool,
  onOpenPath,
  onDoctorRefresh,
  onStopAction,
  testInitialRect,
}: VirtualTranscriptProps) {
  const lastRowIdRef = useRef<string | null>(null);
  const [readyToReveal, setReadyToReveal] = useState(false);
  const [settleTick, setSettleTick] = useState(0);
  const estimatedTotalSize = useMemo(
    () => rows.reduce((total, row) => total + estimateRowSize(row), 0),
    [rows],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      estimateRowSize(rows[index] ?? { kind: "working", id: "fallback", interruptible: true }),
    getItemKey: (index) =>
      transcriptRowKey(
        rows[index] ?? { kind: "working", id: `missing:${index}`, interruptible: true },
      ),
    overscan: 10,
    anchorTo: pinned ? "end" : "start",
    followOnAppend: pinned ? "auto" : false,
    initialOffset: () =>
      pinned ? Math.max(0, estimatedTotalSize - (testInitialRect?.height ?? 0)) : 0,
    initialRect: testInitialRect,
    scrollEndThreshold: 40,
    useAnimationFrameWithResizeObserver: true,
  });

  const scrollToLiveEdge = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (rows.length === 0) {
        return;
      }
      virtualizer.scrollToEnd({ behavior });
    },
    [rows.length, virtualizer],
  );

  useLayoutEffect(() => {
    const last = rows.at(-1)?.id ?? null;
    if (pinned && last !== lastRowIdRef.current) {
      scrollToLiveEdge();
    }
    lastRowIdRef.current = last;
  });

  useEffect(() => {
    if (!pinned) {
      return;
    }
    const frame = requestAnimationFrame(() => scrollToLiveEdge());
    return () => cancelAnimationFrame(frame);
  }, [pinned, scrollToLiveEdge]);

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
    const frame = requestAnimationFrame(() => scrollToLiveEdge());
    return () => cancelAnimationFrame(frame);
  }, [pinned, readyToReveal, scrollToLiveEdge]);

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
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            data-transcript-virtual-row={row.kind}
            className={cn(
              "absolute top-0 left-0 w-full",
              row.kind === "message" && row.compactAbove ? "pb-2" : "pb-8",
            )}
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <TranscriptRowView
              row={row}
              showThinking={showThinking}
              toConcurrentTool={toConcurrentTool}
              onOpenPath={onOpenPath}
              onDoctorRefresh={onDoctorRefresh}
              onStopAction={onStopAction}
            />
          </div>
        );
      })}
    </div>
  );
}
