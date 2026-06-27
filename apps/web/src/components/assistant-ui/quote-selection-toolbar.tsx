"use client";

import { CopyIcon, GitBranchIcon, TextQuoteIcon } from "lucide-react";
import { type FC, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export { buildQuotedComposerText } from "./quote";

const TOOLBAR_CLASS = "aui-selection-toolbar-root";

// Viewport point the toolbar anchors its bottom-center to (with a small gap).
type Anchor = { x: number; y: number };

/**
 * Walks up to the nearest message element. Returns its id only when both ends
 * of the selection live in the same message, so the toolbar is offered for
 * conversation text and not arbitrary page chrome.
 */
const selectionMessageId = (selection: Selection): string | null => {
  const find = (node: Node | null): string | null => {
    let el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
    while (el) {
      const id = el.getAttribute("data-message-id");
      if (id) return id;
      el = el.parentElement;
    }
    return null;
  };

  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return null;

  const anchorId = find(anchorNode);
  if (!anchorId || anchorId !== find(focusNode)) return null;
  return anchorId;
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
 * A floating "Quote" / "Tangent" toolbar that appears when the user
 * drag-highlights (or double-clicks) text inside a conversation message. It is
 * anchored to where the cursor ended up - the pointer release point - rather
 * than the center of the selection.
 *
 * "Quote" hands the selected text to `onQuote` (the host wires it into its own
 * composer, e.g. as a markdown blockquote via buildQuotedComposerText). "Tangent"
 * is a disabled placeholder for now.
 *
 * Composer-agnostic: render it once anywhere in the app; it only needs message
 * elements to carry `data-message-id` so a selection can be scoped to one message.
 */
export const QuoteSelectionToolbar: FC<{ onQuote: (selected: string) => void }> = ({ onQuote }) => {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    // `point` is the pointer position for mouse selections; null for keyboard
    // selections, which fall back to the focus end of the range. A rAF lets the
    // browser finish applying the selection (notably for double-click) first.
    const show = (point: Anchor | null) => {
      requestAnimationFrame(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return setAnchor(null);
        if (!selection.toString().trim()) return setAnchor(null);
        if (!selectionMessageId(selection)) return setAnchor(null);
        setAnchor(point ?? focusEndAnchor(selection));
      });
    };

    const onMouseUp = (e: MouseEvent) => {
      // Ignore clicks on the toolbar itself so it doesn't reposition to itself.
      if ((e.target as Element | null)?.closest(`.${TOOLBAR_CLASS}`)) return;
      show({ x: e.clientX, y: e.clientY });
    };
    const onKeyUp = () => show(null);
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setAnchor(null);
    };
    const onScroll = () => show(null);

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  if (!anchor) return null;

  const handleQuote = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text) return;
    selection?.removeAllRanges();
    setAnchor(null);
    onQuote(text);
  };

  // Copy the highlighted text to the clipboard. A dedicated action because native Cmd+C is
  // fragile here: the transcript re-renders (the host-recency tick, streaming deltas) collapse
  // the selection before the user can press it. We grab the text now, while it is still
  // selected, and dismiss the toolbar (leaving the highlight in place).
  const handleCopy = () => {
    const text = window.getSelection()?.toString().trim();
    if (!text) return;
    void navigator.clipboard?.writeText(text);
    setAnchor(null);
  };

  return <QuoteToolbar anchor={anchor} onCopy={handleCopy} onQuote={handleQuote} />;
};

/**
 * The portaled toolbar. Mounted fresh for each selection so it fades in place:
 * opacity 0 -> 1 on mount, with the positioning transform left untouched (no
 * slide or scale). `onMouseDown` preventDefault keeps the selection alive when a
 * button is clicked.
 */
function QuoteToolbar({
  anchor,
  onCopy,
  onQuote,
}: {
  anchor: Anchor;
  onCopy: () => void;
  onQuote: () => void;
}) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return createPortal(
    <div
      className={cn(
        TOOLBAR_CLASS,
        "bg-popover/95 text-popover-foreground flex items-center gap-0.5 rounded-lg border p-1 shadow-lg backdrop-blur-sm transition-opacity duration-150",
        shown ? "opacity-100" : "opacity-0",
      )}
      style={{
        position: "fixed",
        top: anchor.y - 8,
        left: anchor.x,
        transform: "translate(-50%, -100%)",
        zIndex: 50,
      }}
      // Keep the selection alive when the toolbar is clicked.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={onCopy}
        className="aui-selection-toolbar-copy hover:bg-accent hover:text-accent-foreground flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors"
      >
        <CopyIcon className="size-3.5" />
        Copy
      </button>
      <div className="bg-border/60 h-4 w-px" aria-hidden="true" />
      <button
        type="button"
        onClick={onQuote}
        className="aui-selection-toolbar-quote hover:bg-accent hover:text-accent-foreground flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors"
      >
        <TextQuoteIcon className="size-3.5" />
        Quote
      </button>
      <div className="bg-border/60 h-4 w-px" aria-hidden="true" />
      {/* Tangent is a placeholder for now; wiring comes later. */}
      <button
        type="button"
        disabled
        className="aui-selection-toolbar-tangent flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium opacity-40 transition-colors disabled:cursor-not-allowed"
      >
        <GitBranchIcon className="size-3.5" />
        Tangent
      </button>
    </div>,
    document.body,
  );
}
