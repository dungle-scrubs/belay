/**
 * Logical transcript selection model. A selection is stored as (segment id, character
 * offset) endpoints rather than live DOM nodes, so it survives the two things that destroy
 * a native selection in this app: the browser collapsing `window.getSelection()` on every
 * transcript re-render, and the virtualizer unmounting/remounting rows as they scroll.
 *
 * The visible highlight is re-resolved from this model against the *current* DOM whenever
 * rows churn (see `paintTranscriptHighlight`). Copy/Quote read the captured text snapshot in
 * the toolbar, not this model - this only drives the persistent highlight and lets a later
 * Tangent feature reconstruct the range. <!-- D-001 D-002 -->
 */

// A transcript "segment" is any element carrying a stable message id. Rows remount under
// virtualization but keep the same id, so the id - not the mounted DOM node - anchors the
// selection across churn. <!-- D-003 -->
export const SEGMENT_ATTR = "data-message-id";

const HIGHLIGHT_NAME = "belay-transcript-selection";

/** One endpoint of a logical selection: a segment and a character offset into its text. */
export type SegmentPoint = { segmentId: string; offset: number };

/** A logical transcript selection, normalized so `start` precedes `end` in document order. */
export type TranscriptRange = { start: SegmentPoint; end: SegmentPoint };

/** The minimal slice of `Selection` capture needs - lets jsdom tests pass a plain object. */
export type SelectionEndpoints = Pick<
  Selection,
  "anchorNode" | "anchorOffset" | "focusNode" | "focusOffset"
>;

/** Nearest ancestor element (inclusive) that is a transcript segment, or null. */
export function segmentElementForNode(node: Node | null | undefined): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el) {
    if (el.hasAttribute(SEGMENT_ATTR)) return el;
    el = el.parentElement;
  }
  return null;
}

const segmentIdOf = (el: HTMLElement): string => el.getAttribute(SEGMENT_ATTR) ?? "";

/**
 * Character offset of (node, nodeOffset) measured from the start of `segmentEl`'s text.
 * Uses a throwaway Range + `toString()` so it handles text-node and element-node endpoints
 * uniformly (a selection endpoint can be either). Returns 0 if the point is unmeasurable.
 */
function charOffsetWithin(segmentEl: HTMLElement, node: Node, nodeOffset: number): number {
  const range = segmentEl.ownerDocument.createRange();
  try {
    range.setStart(segmentEl, 0);
    range.setEnd(node, nodeOffset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

/**
 * Captures a native selection as a logical transcript range, or null when either endpoint
 * is not inside a transcript segment (e.g. the composer or page chrome). Unlike the old
 * single-message rule, the two endpoints may live in *different* segments - that is the
 * whole point of cross-item selection. The result is normalized to document order so drag
 * direction (forward vs. backward / shift-extend either way) does not matter. <!-- D-004 -->
 */
export function captureTranscriptRange(sel: SelectionEndpoints): TranscriptRange | null {
  const anchorEl = segmentElementForNode(sel.anchorNode);
  const focusEl = segmentElementForNode(sel.focusNode);
  if (!anchorEl || !focusEl || !sel.anchorNode || !sel.focusNode) return null;

  const anchor: SegmentPoint = {
    segmentId: segmentIdOf(anchorEl),
    offset: charOffsetWithin(anchorEl, sel.anchorNode, sel.anchorOffset),
  };
  const focus: SegmentPoint = {
    segmentId: segmentIdOf(focusEl),
    offset: charOffsetWithin(focusEl, sel.focusNode, sel.focusOffset),
  };

  if (anchorEl === focusEl) {
    return anchor.offset <= focus.offset
      ? { start: anchor, end: focus }
      : { start: focus, end: anchor };
  }
  const focusFollowsAnchor =
    (anchorEl.compareDocumentPosition(focusEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  return focusFollowsAnchor ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/** Maps a character offset within `segmentEl` back to a (text node, offset) DOM point. */
function pointAtOffset(segmentEl: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = segmentEl.ownerDocument.createTreeWalker(segmentEl, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let last: Text | null = null;
  let current = walker.nextNode() as Text | null;
  while (current) {
    const len = current.data.length;
    // `<=` so an offset landing exactly on a node boundary resolves to the end of the
    // earlier node rather than overshooting into the next one.
    if (offset <= consumed + len) return { node: current, offset: Math.max(0, offset - consumed) };
    consumed += len;
    last = current;
    current = walker.nextNode() as Text | null;
  }
  // Past the end (text shrank since capture, e.g. mid-stream): clamp to the last text node.
  return last ? { node: last, offset: last.data.length } : { node: segmentEl, offset: 0 };
}

const escapeSegmentId = (id: string): string =>
  typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id;

/**
 * Rebuilds a live DOM Range from a logical selection against the current document. Returns
 * null when either endpoint's segment is not currently mounted (a virtualized row scrolled
 * out of the window) - the caller repaints once the row remounts.
 */
export function resolveTranscriptRange(
  range: TranscriptRange,
  root: Document | HTMLElement = document,
): Range | null {
  const startEl = root.querySelector<HTMLElement>(
    `[${SEGMENT_ATTR}="${escapeSegmentId(range.start.segmentId)}"]`,
  );
  const endEl = root.querySelector<HTMLElement>(
    `[${SEGMENT_ATTR}="${escapeSegmentId(range.end.segmentId)}"]`,
  );
  if (!startEl || !endEl) return null;

  const start = pointAtOffset(startEl, range.start.offset);
  const end = pointAtOffset(endEl, range.end.offset);
  const doc = root instanceof Document ? root : root.ownerDocument;
  const domRange = doc.createRange();
  try {
    domRange.setStart(start.node, start.offset);
    domRange.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return domRange;
}

/** Selected text of a logical range against the current DOM (fallback when no snapshot). */
export function extractRangeText(
  range: TranscriptRange,
  root: Document | HTMLElement = document,
): string {
  return resolveTranscriptRange(range, root)?.toString() ?? "";
}

// --- CSS Custom Highlight API plumbing -----------------------------------------------------
// Rendering the persistent highlight through `::highlight()` instead of wrapping text in
// spans means the DOM is never mutated, so markdown/tool/question layout cannot be corrupted
// by the highlight - the plan's highest-severity risk. jsdom and pre-2024 browsers lack the
// API; everything below no-ops there and the app falls back to native ::selection only.

type HighlightRegistry = { set(name: string, highlight: object): void; delete(name: string): void };
type HighlightConstructor = new (...ranges: Range[]) => object;

const highlightRegistry = (): HighlightRegistry | null => {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return null;
  return (CSS as unknown as { highlights: HighlightRegistry }).highlights;
};

const highlightConstructor = (): HighlightConstructor | null => {
  const ctor = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  return typeof ctor === "function" ? ctor : null;
};

/** Whether the browser exposes the CSS Custom Highlight API (jsdom and old browsers do not). */
export function supportsHighlightApi(): boolean {
  return highlightRegistry() !== null && highlightConstructor() !== null;
}

/**
 * Paints (or, with a null range, clears) the Belay-owned transcript highlight. Resolving to
 * a missing segment clears rather than leaving a stale highlight, so a scrolled-out row shows
 * nothing until it remounts and the next repaint re-resolves it.
 */
export function paintTranscriptHighlight(
  range: TranscriptRange | null,
  root: Document | HTMLElement = document,
): void {
  const registry = highlightRegistry();
  const Highlight = highlightConstructor();
  if (!registry || !Highlight) return;

  if (!range) {
    registry.delete(HIGHLIGHT_NAME);
    return;
  }
  const domRange = resolveTranscriptRange(range, root);
  if (!domRange) {
    registry.delete(HIGHLIGHT_NAME);
    return;
  }
  registry.set(HIGHLIGHT_NAME, new Highlight(domRange));
}

/** Removes the Belay-owned transcript highlight (no-op where the API is absent). */
export function clearTranscriptHighlight(): void {
  highlightRegistry()?.delete(HIGHLIGHT_NAME);
}
