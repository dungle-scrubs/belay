import assert from "node:assert/strict";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import { QuoteSelectionToolbar } from "./quote-selection-toolbar";

/**
 * Integration test for the selection toolbar: render the real component, drive a real DOM
 * selection (mocked, since jsdom has no layout), and assert the snapshot-driven Copy/Quote
 * wiring. The core guarantee is that actions read a snapshot taken when the selection
 * completed, so they keep working after the browser collapses the live selection (which it
 * does on every transcript re-render). Runs in the on-demand `web` jsdom project
 * (pnpm test:web), not the pre-commit gate.
 */

const flushRaf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

type MockSelection = Selection & { removeAllRanges: ReturnType<typeof vi.fn> };

/** Make window.getSelection report a live, non-collapsed selection of `text` inside `node`. */
function selectText(text: string, node: Node): MockSelection {
  const selection = {
    isCollapsed: false,
    anchorNode: node,
    focusNode: node,
    toString: () => text,
    getRangeAt: () => ({ getClientRects: () => [{ right: 120, top: 40 }] }),
    removeAllRanges: vi.fn(),
  } as unknown as MockSelection;
  vi.spyOn(window, "getSelection").mockReturnValue(selection);
  return selection;
}

/** Make window.getSelection report an empty/collapsed selection (post re-render). */
function collapseSelection() {
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: true,
    toString: () => "",
  } as unknown as Selection);
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
  const selection = selectText(selected, message);
  await act(async () => {
    fireEvent.mouseUp(message as Element, { clientX: 120, clientY: 40 });
    await flushRaf();
    await flushRaf();
  });
  return { onQuote, selection };
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

test("Copy writes the snapshot text after the native selection collapses", async () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await openToolbar("captured passage");

  // A transcript re-render collapses the browser selection while the toolbar is open.
  collapseSelection();
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
    await flushRaf();
  });
  assert.ok(screen.getByText("Copy")); // toolbar survived the collapse

  fireEvent.click(screen.getByText("Copy"));
  assert.equal(writeText.mock.calls[0]?.[0], "captured passage");
});

test("Quote hands the snapshot text after the native selection collapses", async () => {
  const { onQuote } = await openToolbar("quote after collapse");

  collapseSelection();
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
    await flushRaf();
  });

  fireEvent.click(screen.getByText("Quote"));
  assert.equal(onQuote.mock.calls[0]?.[0], "quote after collapse");
});

test("Copy leaves the native selection intact (no removeAllRanges)", async () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const { selection } = await openToolbar("keep me highlighted");

  fireEvent.click(screen.getByText("Copy"));
  assert.equal(selection.removeAllRanges.mock.calls.length, 0);
});

test("a successful Copy dismisses the toolbar", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await openToolbar("dismiss me");

  await act(async () => {
    fireEvent.click(screen.getByText("Copy"));
    await flushMicrotasks();
  });
  assert.equal(screen.queryByText("Copy"), null);
});

test("a failed clipboard write keeps the toolbar open in a retry state", async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error("clipboard denied"));
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await openToolbar("retry me");

  await act(async () => {
    fireEvent.click(screen.getByText("Copy"));
    await flushMicrotasks();
  });

  const root = document.querySelector(".aui-selection-toolbar-root");
  assert.equal(root?.getAttribute("data-copy-failed"), "true");
  assert.ok(screen.getByText("Retry")); // still open, now offering a retry
});

test("a whitespace-only selection does not open the toolbar", async () => {
  const onQuote = vi.fn();
  const { container } = render(
    <div data-message-id="m1">
      <span>{"   "}</span>
      <QuoteSelectionToolbar onQuote={onQuote} />
    </div>,
  );
  const message = container.querySelector("[data-message-id]") as Node;
  selectText("   ", message);
  await act(async () => {
    fireEvent.mouseUp(message as Element, { clientX: 10, clientY: 10 });
    await flushRaf();
  });
  assert.equal(screen.queryByText("Copy"), null);
});

test("a selection spanning two messages does not open the toolbar", async () => {
  const onQuote = vi.fn();
  const { container } = render(
    <div>
      <div data-message-id="m1">
        <span>first message</span>
      </div>
      <div data-message-id="m2">
        <span>second message</span>
      </div>
      <QuoteSelectionToolbar onQuote={onQuote} />
    </div>,
  );
  const m1 = container.querySelector('[data-message-id="m1"]') as Node;
  const m2 = container.querySelector('[data-message-id="m2"]') as Node;
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    anchorNode: m1,
    focusNode: m2,
    toString: () => "first message second message",
    getRangeAt: () => ({ getClientRects: () => [{ right: 50, top: 20 }] }),
    removeAllRanges: vi.fn(),
  } as unknown as Selection);

  await act(async () => {
    fireEvent.mouseUp(document.body, { clientX: 50, clientY: 20 });
    await flushRaf();
  });
  assert.equal(screen.queryByText("Copy"), null);
});

test("a plain click outside the toolbar dismisses it", async () => {
  await openToolbar("dismiss on click away");

  collapseSelection();
  await act(async () => {
    fireEvent.mouseUp(document.body, { clientX: 5, clientY: 5 });
    await flushRaf();
  });
  assert.equal(screen.queryByText("Copy"), null);
});

test("Copy and Quote are real, enabled buttons (keyboard activatable)", async () => {
  await openToolbar("keyboard reachable");
  const copy = screen.getByText("Copy").closest("button");
  const quote = screen.getByText("Quote").closest("button");
  assert.equal(copy?.tagName, "BUTTON");
  assert.equal(quote?.tagName, "BUTTON");
  assert.notEqual(copy?.disabled, true);
  assert.notEqual(quote?.disabled, true);
});

test("scrolling keeps the active selection and repositions the toolbar", async () => {
  const onQuote = vi.fn();
  const { container } = render(
    <div data-message-id="m1">
      <span>long selectable passage</span>
      <QuoteSelectionToolbar onQuote={onQuote} />
    </div>,
  );
  const message = container.querySelector("[data-message-id]") as Node;
  const selection = selectText("long selectable passage", message);

  await act(async () => {
    fireEvent.mouseUp(message as Element, { clientX: 120, clientY: 40 });
    await flushRaf();
    await flushRaf();
  });
  assert.ok(screen.getByText("Quote"));

  await act(async () => {
    fireEvent.scroll(document);
    await flushRaf();
    await flushRaf();
  });

  assert.ok(screen.getByText("Quote"));
  assert.equal(selection.removeAllRanges.mock.calls.length, 0);
});

test("survives a virtual-list unmount/remount of the source message", async () => {
  // Regression guard: the transcript is virtualized, so the message node is unmounted and
  // remounted constantly while it is still logically present. The toolbar must NOT dismiss
  // when the source row's DOM node briefly disappears - that was the bug that made the
  // toolbar vanish on every active session.
  function Harness({ mounted }: { mounted: boolean }) {
    return (
      <div>
        {mounted ? (
          <div data-message-id="m1">
            <span>churning row</span>
          </div>
        ) : null}
        <QuoteSelectionToolbar onQuote={vi.fn()} />
      </div>
    );
  }

  const { container, rerender } = render(<Harness mounted />);
  const message = container.querySelector('[data-message-id="m1"]') as Node;
  selectText("churning row", message);
  await act(async () => {
    fireEvent.mouseUp(message as Element, { clientX: 30, clientY: 30 });
    await flushRaf();
    await flushRaf();
  });
  assert.ok(screen.getByText("Copy"));

  // The virtualizer transiently unmounts the source row...
  await act(async () => {
    rerender(<Harness mounted={false} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(screen.getByText("Copy")); // toolbar survives the unmount

  // ...and remounts it on the next window pass.
  await act(async () => {
    rerender(<Harness mounted />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(screen.getByText("Copy"));
});

test("survives a transcript re-render that keeps the source message mounted", async () => {
  function Harness({ tick }: { tick: number }) {
    return (
      <div>
        <div data-message-id="m1">
          <span>persisted message</span>
          {/* A streaming sibling churns on every host tick; the source message stays. */}
          <span data-streaming>{`token ${tick}`}</span>
        </div>
        <QuoteSelectionToolbar onQuote={vi.fn()} />
      </div>
    );
  }

  const { container, rerender } = render(<Harness tick={0} />);
  const message = container.querySelector('[data-message-id="m1"]') as Node;
  selectText("persisted message", message);
  await act(async () => {
    fireEvent.mouseUp(message as Element, { clientX: 30, clientY: 30 });
    await flushRaf();
    await flushRaf();
  });
  assert.ok(screen.getByText("Copy"));

  // Several re-renders that collapse the selection but keep the message mounted.
  collapseSelection();
  await act(async () => {
    rerender(<Harness tick={1} />);
    rerender(<Harness tick={2} />);
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(screen.getByText("Copy")); // payload persisted across the churn
});
