"use client";

import { CopyIcon, GitBranchIcon, TextQuoteIcon } from "lucide-react";
import { type FC, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  type Anchor,
  clampToolbarPosition,
  type ToolbarSize,
} from "./quote-selection-placement";
import {
  captureTranscriptRange,
  clearTranscriptHighlight,
  paintTranscriptHighlight,
  supportsHighlightApi,
  type TranscriptRange,
} from "./transcript-selection";

export { buildQuotedComposerText } from "./quote";

const TOOLBAR_CLASS = "aui-selection-toolbar-root";

/**
 * The payload a "Tangent" action carries (plan 37, M3): the stable selected-text snapshot plus the
 * SINGLE source message it was scoped to. A tangent seeds from one message's selection, so the action
 * only fires for a selection contained in one `data-message-id` (a cross-item selection has no single
 * source and leaves Tangent disabled).
 */
export type TangentSelection = {
  readonly text: string;
  readonly sourceMessageId: string;
};

/**
 * The single source message id of a range, or null when the selection is NOT contained in one message
 * (its endpoints live in different segments, or it touched no segment). Copy/Quote accept cross-item
 * ranges; Tangent requires exactly one source.
 */
const singleSourceMessageId = (range: TranscriptRange | null): string | null => {
  if (!range || range.start.segmentId !== range.end.segmentId || !range.start.segmentId) {
    return null;
  }
  return range.start.segmentId;
};

// Until the toolbar measures itself, place it with these declared dimensions so the
// first paint is already roughly clamped. Real width is read back in a layout effect.
const DEFAULT_TOOLBAR_SIZE: ToolbarSize = { width: 224, height: 34 };

/**
 * What the toolbar copies/quotes from. Captured once when a selection completes, so
 * the actions keep working after the browser collapses the live selection - which it
 * does on every transcript re-render (host recency tick, streaming delta, virtual-list
 * refresh). Snapshotting is the whole fix: actions read `text`, never a later
 * `window.getSelection()`. <!-- D-001 -->
 */
type SelectionSnapshot = {
  /** The trimmed selected text, frozen at capture time (may span several transcript items). */
  text: string;
  /** Logical (segment id + offset) range that drives the persisted highlight across re-renders
   *  and row remount. Null when the browser lacks the CSS Custom Highlight API. <!-- D-002 --> */
  range: TranscriptRange | null;
  /** Viewport point to anchor the toolbar above (pointer release or focus end). */
  anchor: Anchor;
  /** Capture time (ms epoch); resets transient UI state (e.g. a copy error) per selection. */
  capturedAt: number;
};

/**
 * The point where the selection ended: the pointer position for mouse-driven
 * selections (drag release / double-click), or the focus end of the range for
 * keyboard selections.
 */
const focusEndAnchor = (selection: Selection): Anchor | null => {
  const rects = selection.getRangeAt(0).getClientRects();
  const last = rects[rects.length - 1];
  return last ? { x: last.right, y: last.top } : null;
};

/**
 * Snapshots the current selection, or returns null when there is nothing to act on:
 * an empty/collapsed selection, whitespace-only text, or a selection that touches no
 * transcript segment (the composer or page chrome). The selection MAY span several
 * transcript items - cross-item ranges are captured, not rejected. `point` is the
 * pointer release for mouse selections, null for keyboard/scroll where we fall back to
 * the focus-end rect. <!-- D-004 -->
 */
const captureSelection = (point: Anchor | null): SelectionSnapshot | null => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;

  const text = selection.toString().trim();
  if (!text) return null;

  const range = captureTranscriptRange(selection);
  if (!range) return null;

  const anchor = point ?? focusEndAnchor(selection);
  if (!anchor) return null;

  return { text, range, anchor, capturedAt: Date.now() };
};

/**
 * Keeps the Trevor-owned highlight painted from the logical `range` for as long as the
 * snapshot lives. Two signals drive a repaint: `selectionchange` (so the highlight takes
 * over the instant the native selection collapses on a re-render) and a MutationObserver on
 * the virtual list (so the highlight re-resolves when a virtualized row remounts with fresh
 * DOM nodes). While a live native selection still exists we defer to native `::selection` -
 * identical color, no double paint - and only render the persisted highlight after it
 * collapses. No-ops where the CSS Custom Highlight API is absent (jsdom, old browsers).
 * <!-- D-002 -->
 */
const usePersistedHighlight = (range: TranscriptRange | null): void => {
  useEffect(() => {
    if (!range || !supportsHighlightApi()) return;

    const root =
      document.querySelector<HTMLElement>("[data-transcript-virtual-list]") ?? document.body;
    let frame = 0;
    const repaint = () => {
      frame = 0;
      const selection = window.getSelection();
      const nativeLive =
        !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
      paintTranscriptHighlight(nativeLive ? null : range);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(repaint);
    };

    repaint();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    document.addEventListener("selectionchange", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("selectionchange", schedule);
      clearTranscriptHighlight();
    };
  }, [range]);
};

/**
 * A floating "Copy" / "Quote" / "Tangent" toolbar that appears when the user
 * drag-highlights (or double-clicks) text inside a conversation message. It is
 * anchored to where the cursor ended up - the pointer release point - rather than
 * the center of the selection, and clamps inside the viewport so it is never clipped
 * at an edge. <!-- D-002 -->
 *
 * On selection completion it snapshots the selected text + source message, then drives
 * every action from that snapshot. The native highlight may vanish on the next
 * transcript re-render; the toolbar and its actions stay correct regardless.
 *
 * "Copy" writes the snapshot to the clipboard (leaving any surviving highlight in
 * place); "Quote" hands the text to `onQuote` (the host wires it into its composer as
 * a markdown blockquote via buildQuotedComposerText); "Tangent" (plan 37) hands the
 * snapshot + its single source message id to `onTangent`, and is enabled only when the
 * selection is contained in ONE message (a cross-item selection has no single source).
 * When `onTangent` is omitted (Storybook-only), Tangent stays disabled.
 *
 * Composer-agnostic: render it once anywhere in the app; it only needs transcript items
 * to carry `data-message-id` so a selection (single- or cross-item) can be scoped to
 * conversation text and re-resolved after the native selection collapses.
 */
export const QuoteSelectionToolbar: FC<{
  onQuote: (selected: string) => void;
  onTangent?: (selection: TangentSelection) => void;
}> = ({ onQuote, onTangent }) => {
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  const capturedAt = snapshot?.capturedAt ?? null;

  // Each fresh selection clears any leftover copy-error styling from the last one.
  useEffect(() => setCopyFailed(false), [capturedAt]);

  // Paint the persisted highlight from the snapshot's logical range so the selection stays
  // visible after the native selection collapses or the source rows remount. <!-- D-002 -->
  usePersistedHighlight(snapshot?.range ?? null);

  useEffect(() => {
    // A rAF lets the browser finish applying the selection (notably for double-click)
    // before we read it.
    const capture = (point: Anchor | null, onEmpty: () => void) => {
      requestAnimationFrame(() => {
        const next = captureSelection(point);
        if (next) {
          setSnapshot(next);
        } else {
          onEmpty();
        }
      });
    };

    const onMouseUp = (e: MouseEvent) => {
      // Ignore clicks on the toolbar itself so it neither repositions to itself nor
      // dismisses when an action button is pressed.
      if ((e.target as Element | null)?.closest(`.${TOOLBAR_CLASS}`)) return;
      // A drag release with text opens/moves the toolbar; a plain click (collapsed
      // selection) is an outside click that dismisses it.
      capture({ x: e.clientX, y: e.clientY }, () => setSnapshot(null));
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Escape") return setSnapshot(null);
      // Keyboard selection (shift+arrows) opens/moves the toolbar; a keystroke with no
      // selection (e.g. typing in the composer) leaves an open toolbar untouched.
      capture(null, () => {});
    };

    // Scroll reattaches the toolbar to the live selection while it survives; once the
    // selection has collapsed (re-render), the snapshot stays put - never dismissed here.
    const onScroll = () => capture(null, () => {});

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  // Note on dismissal: we deliberately do NOT watch the DOM for the source message
  // disappearing. The transcript is virtualized (@tanstack/react-virtual re-windows on
  // every measure/scroll/recency tick), so the message node is unmounted and remounted
  // constantly while it is still logically present - any DOM-presence signal dismisses
  // the toolbar the instant the row churns, which is exactly the regression to avoid.
  // The snapshot is meant to survive that churn. Surface changes that should dismiss
  // (switching sessions, opening the model takeover, soft-deleting) all happen via a
  // click, which the outside-click path below already handles; Escape and completing an
  // action dismiss too.

  if (!snapshot) return null;

  // Quote drops the captured text into the composer and dismisses. Clearing the native
  // highlight is safe (the text is already snapshotted) and tidies the transcript.
  const handleQuote = () => {
    window.getSelection()?.removeAllRanges?.();
    setSnapshot(null);
    onQuote(snapshot.text);
  };

  // Copy writes the snapshot - never a live selection read - and deliberately does NOT
  // call removeAllRanges, so any surviving highlight stays. On success it dismisses; on
  // failure (permissions/focus, or no clipboard API) it keeps the toolbar open in an
  // error state so the snapshot is still there to retry. <!-- D-001 -->
  const handleCopy = () => {
    void copyText(snapshot.text).then((ok) => (ok ? setSnapshot(null) : setCopyFailed(true)));
  };

  // Tangent seeds from a SINGLE message's selection: available only when `onTangent` is wired AND the
  // range resolves to one source message. It hands the frozen snapshot (never a live selection read) +
  // that source id up, then dismisses - the tangent takeover owns the flow from there. <!-- D-002 -->
  const tangentSourceId = singleSourceMessageId(snapshot.range);
  const handleTangent =
    onTangent && tangentSourceId
      ? () => {
          window.getSelection()?.removeAllRanges?.();
          setSnapshot(null);
          onTangent({ text: snapshot.text, sourceMessageId: tangentSourceId });
        }
      : null;

  return (
    <SelectionToolbar
      anchor={snapshot.anchor}
      copyFailed={copyFailed}
      onCopy={handleCopy}
      onQuote={handleQuote}
      onTangent={handleTangent}
    />
  );
};

/**
 * The portaled toolbar. It measures itself once (jsdom returns 0, so it falls back to
 * declared dimensions) and clamps its position inside the viewport before the browser
 * paints, then fades in (opacity 0 -> 1) with no slide or scale. `onMouseDown`
 * preventDefault keeps any native selection alive when a button is pressed.
 */
export function SelectionToolbar({
  anchor,
  copyFailed,
  onCopy,
  onQuote,
  onTangent,
}: {
  anchor: Anchor;
  copyFailed: boolean;
  onCopy: () => void;
  onQuote: () => void;
  /** Opens a tangent from the selection; null/omitted disables Tangent (cross-item selection, or unwired). */
  onTangent?: (() => void) | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<ToolbarSize | null>(null);
  const [shown, setShown] = useState(false);

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect && rect.width > 0) setSize({ width: rect.width, height: rect.height });
    setShown(true);
  }, []);

  const { left, top } = clampToolbarPosition(anchor, size ?? DEFAULT_TOOLBAR_SIZE, {
    width: window.innerWidth,
    height: window.innerHeight,
  });

  return createPortal(
    <div
      ref={ref}
      className={cn(
        TOOLBAR_CLASS,
        "bg-popover/95 text-popover-foreground flex items-center gap-0.5 rounded-lg border p-1 shadow-lg backdrop-blur-sm transition-opacity duration-150",
        copyFailed && "border-destructive/60",
        shown ? "opacity-100" : "opacity-0",
      )}
      style={{ position: "fixed", top, left, zIndex: 50 }}
      data-copy-failed={copyFailed ? "true" : undefined}
      // Keep any native selection alive when the toolbar is clicked.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={onCopy}
        title={copyFailed ? "Copy failed - click to retry" : "Copy selection"}
        className={cn(
          "aui-selection-toolbar-copy hover:bg-accent hover:text-accent-foreground flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
          copyFailed && "text-destructive hover:text-destructive",
        )}
      >
        <CopyIcon className="size-3.5" />
        {copyFailed ? "Retry" : "Copy"}
      </button>
      <div className="bg-border/60 h-4 w-px" aria-hidden="true" />
      <button
        type="button"
        onClick={onQuote}
        title="Quote selection into the composer"
        className="aui-selection-toolbar-quote hover:bg-accent hover:text-accent-foreground flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors"
      >
        <TextQuoteIcon className="size-3.5" />
        Quote
      </button>
      <div className="bg-border/60 h-4 w-px" aria-hidden="true" />
      {/* Tangent (plan 37): enabled only for a single-message selection with a wired handler; otherwise
        a dimmed, disabled affordance (cross-item selection, or a Storybook-only render). */}
      <button
        type="button"
        onClick={onTangent ?? undefined}
        disabled={!onTangent}
        title={
          onTangent
            ? "Open a tangent from this selection"
            : "Select within one message to open a tangent"
        }
        className={cn(
          "aui-selection-toolbar-tangent flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
          onTangent
            ? "cursor-pointer hover:bg-accent hover:text-accent-foreground"
            : "opacity-40 disabled:cursor-not-allowed",
        )}
      >
        <GitBranchIcon className="size-3.5" />
        Tangent
      </button>
    </div>,
    document.body,
  );
}
