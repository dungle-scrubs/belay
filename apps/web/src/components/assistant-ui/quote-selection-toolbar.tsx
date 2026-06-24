"use client";

import { useThreadRuntime } from "@assistant-ui/react";
import { GitBranchIcon, TextQuoteIcon } from "lucide-react";
import { useEffect, useState, type FC } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Wraps each line of `selected` in a markdown blockquote marker. Empty lines
 * become a bare `>` so the quote stays a single contiguous block.
 */
const toBlockquote = (selected: string): string =>
  selected
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");

/**
 * Builds the new composer value when quoting `selected` into a composer that
 * already holds `existing`. The quote is appended below any existing text,
 * separated by a blank line, and the returned `cursor` lands on the empty line
 * beneath the quote (GitHub-style) so the user can type their reference.
 */
export const buildQuotedComposerText = (
  existing: string,
  selected: string,
): { value: string; cursor: number } => {
  const quote = toBlockquote(selected.trim());
  const base = existing.replace(/\s+$/, "");
  const prefix = base.length > 0 ? `${base}\n\n` : "";
  const value = `${prefix}${quote}\n\n`;

  return { value, cursor: value.length };
};

// The visible composer textarea (react-textarea-autosize's measurement clone is
// aria-hidden and never carries this class).
const COMPOSER_INPUT_SELECTOR =
  'textarea.aui-composer-input:not([aria-hidden="true"])';

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
 * "Quote" drops the selection into the prompt composer as a markdown blockquote
 * and parks the cursor on a fresh line below, ready to reference. "Tangent" is
 * a disabled placeholder for now.
 *
 * Render this once inside the thread, alongside `<Thread />`, within the
 * `AssistantRuntimeProvider`.
 */
export const QuoteSelectionToolbar: FC = () => {
  const thread = useThreadRuntime();
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
    const onScroll = () => setAnchor(null);

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

    const composer = thread.composer;
    const { value, cursor } = buildQuotedComposerText(
      composer.getState().text,
      text,
    );
    composer.setText(value);
    selection?.removeAllRanges();
    setAnchor(null);

    // The composer textarea is controlled, so its DOM value updates on the
    // next commit. Wait a frame before focusing and parking the cursor.
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        COMPOSER_INPUT_SELECTOR,
      );
      if (!input) return;
      input.focus();
      input.setSelectionRange(cursor, cursor);
    });
  };

  return <QuoteToolbar anchor={anchor} onQuote={handleQuote} />;
};

/**
 * The portaled toolbar. Mounted fresh for each selection so it fades in place:
 * opacity 0 -> 1 on mount, with the positioning transform left untouched (no
 * slide or scale). `onMouseDown` preventDefault keeps the selection alive when a
 * button is clicked.
 */
function QuoteToolbar({ anchor, onQuote }: { anchor: Anchor; onQuote: () => void }) {
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
