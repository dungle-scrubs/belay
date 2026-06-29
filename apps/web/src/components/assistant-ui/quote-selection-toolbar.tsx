"use client";

import { CopyIcon, GitBranchIcon, TextQuoteIcon } from "lucide-react";
import { type FC, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
  type Anchor,
  clampToolbarPosition,
  type ToolbarSize,
} from "./quote-selection-placement";

export { buildQuotedComposerText } from "./quote";

const TOOLBAR_CLASS = "aui-selection-toolbar-root";

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
  /** The trimmed selected text, frozen at capture time. */
  text: string;
  /** The single message (`data-message-id`) the selection lived in. */
  messageId: string;
  /** Viewport point to anchor the toolbar above (pointer release or focus end). */
  anchor: Anchor;
  /** Capture time (ms epoch); resets transient UI state (e.g. a copy error) per selection. */
  capturedAt: number;
};

/**
 * Walks up to the nearest message element. Returns its id only when both ends
 * of the selection live in the same message, so the toolbar is offered for
 * conversation text and not arbitrary page chrome or cross-message drags.
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
 * Snapshots the current selection, or returns null when there is nothing to act on:
 * an empty/collapsed selection, whitespace-only text, or a selection that spans
 * messages (or none). `point` is the pointer release for mouse selections, null for
 * keyboard/scroll where we fall back to the focus-end rect.
 */
const captureSelection = (point: Anchor | null): SelectionSnapshot | null => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;

  const text = selection.toString().trim();
  if (!text) return null;

  const messageId = selectionMessageId(selection);
  if (!messageId) return null;

  const anchor = point ?? focusEndAnchor(selection);
  if (!anchor) return null;

  return { text, messageId, anchor, capturedAt: Date.now() };
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
 * a markdown blockquote via buildQuotedComposerText); "Tangent" is a disabled
 * placeholder for now.
 *
 * Composer-agnostic: render it once anywhere in the app; it only needs message
 * elements to carry `data-message-id` so a selection can be scoped to one message.
 */
export const QuoteSelectionToolbar: FC<{ onQuote: (selected: string) => void }> = ({ onQuote }) => {
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  const capturedAt = snapshot?.capturedAt ?? null;

  // Each fresh selection clears any leftover copy-error styling from the last one.
  useEffect(() => setCopyFailed(false), [capturedAt]);

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
    const writeText = navigator.clipboard?.writeText;
    if (!writeText) return setCopyFailed(true);
    Promise.resolve(writeText.call(navigator.clipboard, snapshot.text)).then(
      () => setSnapshot(null),
      () => setCopyFailed(true),
    );
  };

  return (
    <SelectionToolbar
      anchor={snapshot.anchor}
      copyFailed={copyFailed}
      onCopy={handleCopy}
      onQuote={handleQuote}
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
}: {
  anchor: Anchor;
  copyFailed: boolean;
  onCopy: () => void;
  onQuote: () => void;
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
