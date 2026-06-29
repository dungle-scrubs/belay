import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  captureTranscriptRange,
  clearTranscriptHighlight,
  extractRangeText,
  paintTranscriptHighlight,
  resolveTranscriptRange,
  type SelectionEndpoints,
  segmentElementForNode,
  supportsHighlightApi,
} from "./transcript-selection";

/**
 * Pure DOM tests for the logical transcript-range model (M3/M4). They run in the jsdom `web`
 * project and exercise the parts that survive native-selection collapse and virtual-row
 * remount WITHOUT the CSS Custom Highlight API (jsdom lacks it - that path is Storybook/EZE).
 * Each test builds a real DOM and drives capture/resolve directly, so it never depends on
 * jsdom's partial `window.getSelection()`.
 */

let root: HTMLElement;

function mount(html: string): HTMLElement {
  root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

/** First text node inside the element matched by `selector`. */
function textNode(selector: string): Text {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  const node = el.firstChild;
  if (!(node instanceof Text)) throw new Error(`no text node in ${selector}`);
  return node;
}

const endpoints = (
  anchorNode: Node,
  anchorOffset: number,
  focusNode: Node,
  focusOffset: number,
): SelectionEndpoints => ({ anchorNode, anchorOffset, focusNode, focusOffset });

afterEach(() => {
  root?.remove();
});

test("segmentElementForNode walks up to the nearest data-message-id", () => {
  mount(`<div data-message-id="m1"><p><span>deep text</span></p></div>`);
  const span = textNode("span");
  assert.equal(segmentElementForNode(span)?.getAttribute("data-message-id"), "m1");
});

test("segmentElementForNode returns null outside any segment", () => {
  mount(`<div class="composer"><textarea>typed</textarea></div>`);
  assert.equal(segmentElementForNode(root.querySelector("textarea")), null);
});

test("captures a single-segment range as offsets into that segment", () => {
  mount(`<div data-message-id="m1">hello world</div>`);
  const t = textNode('[data-message-id="m1"]');
  const range = captureTranscriptRange(endpoints(t, 0, t, 5));
  assert.deepEqual(range, { start: { segmentId: "m1", offset: 0 }, end: { segmentId: "m1", offset: 5 } });
});

test("captures a cross-item range spanning two segments", () => {
  mount(`<div data-message-id="m1">first message</div><div data-message-id="m2">second message</div>`);
  const a = textNode('[data-message-id="m1"]');
  const b = textNode('[data-message-id="m2"]');
  const range = captureTranscriptRange(endpoints(a, 6, b, 6));
  assert.deepEqual(range, {
    start: { segmentId: "m1", offset: 6 },
    end: { segmentId: "m2", offset: 6 },
  });
});

test("normalizes a backward (focus-before-anchor) selection to document order", () => {
  mount(`<div data-message-id="m1">first message</div><div data-message-id="m2">second message</div>`);
  const a = textNode('[data-message-id="m1"]');
  const b = textNode('[data-message-id="m2"]');
  // Anchor in the LATER segment, focus in the earlier one (dragged up / shift+up).
  const range = captureTranscriptRange(endpoints(b, 6, a, 6));
  assert.deepEqual(range, {
    start: { segmentId: "m1", offset: 6 },
    end: { segmentId: "m2", offset: 6 },
  });
});

test("normalizes a backward single-segment selection by offset", () => {
  mount(`<div data-message-id="m1">hello world</div>`);
  const t = textNode('[data-message-id="m1"]');
  const range = captureTranscriptRange(endpoints(t, 9, t, 2));
  assert.deepEqual(range, { start: { segmentId: "m1", offset: 2 }, end: { segmentId: "m1", offset: 9 } });
});

test("rejects a selection whose endpoint is outside any transcript segment", () => {
  mount(`<div data-message-id="m1">in transcript</div><textarea>composer</textarea>`);
  const a = textNode('[data-message-id="m1"]');
  const composer = root.querySelector("textarea") as Node;
  assert.equal(captureTranscriptRange(endpoints(a, 0, composer, 3)), null);
});

test("offsets are measured across nested inline markup", () => {
  mount(`<div data-message-id="m1">a<strong>bc</strong>d<em>ef</em></div>`);
  const em = textNode("em");
  // Text content is "abcdef"; the <em> text starts at index 4, so offset 1 into it is 5.
  const range = captureTranscriptRange(endpoints(textNode('[data-message-id="m1"]'), 0, em, 1));
  assert.equal(range?.end.offset, 5);
});

test("resolves a logical range back to selected text", () => {
  mount(`<div data-message-id="m1">the selected passage here</div>`);
  const range = { start: { segmentId: "m1", offset: 4 }, end: { segmentId: "m1", offset: 21 } };
  assert.equal(extractRangeText(range, root), "selected passage ");
});

test("resolves a cross-item range to ordered text spanning both segments", () => {
  mount(`<div data-message-id="m1">alpha</div><div data-message-id="m2">bravo</div>`);
  const range = { start: { segmentId: "m1", offset: 2 }, end: { segmentId: "m2", offset: 3 } };
  // Spans "pha" + segment boundary + "bra"; the exact boundary whitespace is browser-defined,
  // so assert the ordered endpoints survive rather than the inter-segment separator.
  const text = extractRangeText(range, root);
  assert.ok(text.startsWith("pha"));
  assert.ok(text.endsWith("bra"));
});

test("returns null when a segment is not mounted, then re-resolves after remount", () => {
  mount(`<div data-message-id="m1">present</div>`);
  const range = { start: { segmentId: "m1", offset: 0 }, end: { segmentId: "m2", offset: 5 } };
  // m2 is virtualized out: cannot resolve yet (caller leaves the highlight cleared).
  assert.equal(resolveTranscriptRange(range, root), null);

  // The virtualizer remounts m2 on the next window pass.
  const m2 = document.createElement("div");
  m2.setAttribute("data-message-id", "m2");
  m2.textContent = "later";
  root.appendChild(m2);
  assert.notEqual(resolveTranscriptRange(range, root), null);
});

test("resolves the same logical range after a row unmounts and remounts with fresh nodes", () => {
  mount(`<div data-message-id="m1">stable identity text</div>`);
  const range = { start: { segmentId: "m1", offset: 0 }, end: { segmentId: "m1", offset: 6 } };
  assert.equal(extractRangeText(range, root), "stable");

  // Simulate virtualization: drop the row entirely, then recreate it with brand-new DOM nodes.
  root.innerHTML = "";
  const remounted = document.createElement("div");
  remounted.setAttribute("data-message-id", "m1");
  remounted.textContent = "stable identity text";
  root.appendChild(remounted);
  assert.equal(extractRangeText(range, root), "stable");
});

// --- CSS Custom Highlight API (M5) ---------------------------------------------------------
// jsdom ships neither `CSS.highlights` nor `Highlight`, so we stub both to test the paint/clear
// handoff that keeps the selection visible after the native selection collapses. The real
// pixel rendering through `::highlight()` is covered by Storybook + the manual browser EZE.

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

function withHighlightApi(fn: (registry: Map<string, FakeHighlight>) => void): void {
  const registry = new Map<string, FakeHighlight>();
  const cssGlobal = globalThis as { CSS?: { highlights?: unknown } };
  const hadCss = typeof cssGlobal.CSS !== "undefined";
  const priorHighlights = hadCss ? cssGlobal.CSS?.highlights : undefined;
  if (!hadCss) cssGlobal.CSS = {};
  Object.defineProperty(cssGlobal.CSS as object, "highlights", {
    value: registry,
    configurable: true,
    writable: true,
  });
  (globalThis as { Highlight?: unknown }).Highlight = FakeHighlight;
  try {
    fn(registry);
  } finally {
    if (hadCss) {
      Object.defineProperty(cssGlobal.CSS as object, "highlights", {
        value: priorHighlights,
        configurable: true,
        writable: true,
      });
    } else {
      cssGlobal.CSS = undefined;
    }
    (globalThis as { Highlight?: unknown }).Highlight = undefined;
  }
}

test("supportsHighlightApi is false in bare jsdom and true once the API is present", () => {
  assert.equal(supportsHighlightApi(), false);
  withHighlightApi(() => assert.equal(supportsHighlightApi(), true));
});

test("paints a highlight resolved from the logical range", () => {
  mount(`<div data-message-id="m1">paint me please</div>`);
  withHighlightApi((registry) => {
    paintTranscriptHighlight({ start: { segmentId: "m1", offset: 0 }, end: { segmentId: "m1", offset: 5 } }, root);
    const highlight = registry.get("trevor-transcript-selection");
    assert.ok(highlight);
    assert.equal(highlight?.ranges[0]?.toString(), "paint");
  });
});

test("a null range clears any existing highlight (dismissal)", () => {
  mount(`<div data-message-id="m1">clear me</div>`);
  withHighlightApi((registry) => {
    paintTranscriptHighlight({ start: { segmentId: "m1", offset: 0 }, end: { segmentId: "m1", offset: 5 } }, root);
    assert.ok(registry.has("trevor-transcript-selection"));
    paintTranscriptHighlight(null, root);
    assert.equal(registry.has("trevor-transcript-selection"), false);
  });
});

test("a range whose segment is unmounted clears rather than leaving a stale highlight", () => {
  mount(`<div data-message-id="m1">only one here</div>`);
  withHighlightApi((registry) => {
    paintTranscriptHighlight({ start: { segmentId: "m1", offset: 0 }, end: { segmentId: "m1", offset: 4 } }, root);
    assert.ok(registry.has("trevor-transcript-selection"));
    // The end segment scrolls out of the virtual window: the highlight must not linger stale.
    paintTranscriptHighlight({ start: { segmentId: "m1", offset: 0 }, end: { segmentId: "gone", offset: 4 } }, root);
    assert.equal(registry.has("trevor-transcript-selection"), false);
  });
});

test("clearTranscriptHighlight removes the painted highlight", () => {
  mount(`<div data-message-id="m1">bye</div>`);
  withHighlightApi((registry) => {
    paintTranscriptHighlight({ start: { segmentId: "m1", offset: 0 }, end: { segmentId: "m1", offset: 3 } }, root);
    assert.ok(registry.has("trevor-transcript-selection"));
    clearTranscriptHighlight();
    assert.equal(registry.has("trevor-transcript-selection"), false);
  });
});
