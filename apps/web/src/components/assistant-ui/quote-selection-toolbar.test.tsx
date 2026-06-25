import assert from "node:assert/strict";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import { QuoteSelectionToolbar } from "./quote-selection-toolbar";

/**
 * Integration test for the selection toolbar: render the real component, drive a real DOM
 * selection (mocked, since jsdom has no layout), and assert the Copy/Quote wiring. Guards the
 * three things that were broken - Copy must reach the clipboard, Quote must hand the text to
 * the composer, and Tangent stays a disabled placeholder. Runs in the on-demand `web` jsdom
 * project (pnpm test:web), not the pre-commit gate.
 */

const flushRaf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Make window.getSelection report a live, non-collapsed selection of `text` inside `node`. */
function selectText(text: string, node: Node) {
  const selection = {
    isCollapsed: false,
    anchorNode: node,
    focusNode: node,
    toString: () => text,
    getRangeAt: () => ({ getClientRects: () => [{ right: 120, top: 40 }] }),
    removeAllRanges: vi.fn(),
  } as unknown as Selection;
  vi.spyOn(window, "getSelection").mockReturnValue(selection);
}

/** Render the toolbar over a message, select text, and release the mouse to summon it. */
async function openToolbar(selected: string) {
  const onQuote = vi.fn();
  const { container } = render(
    <div data-message-id="m1">
      <span>{selected}</span>
      <QuoteSelectionToolbar onQuote={onQuote} />
    </div>,
  );
  const message = container.querySelector("[data-message-id]") as Node;
  selectText(selected, message);
  await act(async () => {
    fireEvent.mouseUp(message as Element, { clientX: 120, clientY: 40 });
    await flushRaf();
    await flushRaf();
  });
  return { onQuote };
}

afterEach(() => vi.restoreAllMocks());

test("appears with Copy, Quote, and a disabled Tangent on a message selection", async () => {
  await openToolbar("hello world");
  assert.ok(screen.getByText("Copy"));
  assert.ok(screen.getByText("Quote"));
  assert.equal(screen.getByText("Tangent").closest("button")?.disabled, true);
});

test("Copy writes the selected text to the clipboard", async () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await openToolbar("the selected passage");

  fireEvent.click(screen.getByText("Copy"));
  assert.equal(writeText.mock.calls[0]?.[0], "the selected passage");
});

test("Quote hands the selected text to onQuote (the composer)", async () => {
  const { onQuote } = await openToolbar("quote me into the composer");

  fireEvent.click(screen.getByText("Quote"));
  assert.equal(onQuote.mock.calls[0]?.[0], "quote me into the composer");
});
