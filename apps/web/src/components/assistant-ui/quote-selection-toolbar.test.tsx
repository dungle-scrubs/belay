import assert from "node:assert/strict";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, test, vi } from "vitest";
import { QuoteSelectionToolbar, type TangentSelection } from "./quote-selection-toolbar";

type TangentSpy = ReturnType<typeof vi.fn<(selection: TangentSelection) => void>>;

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
async function openToolbar(selected: string, opts: { onTangent?: TangentSpy } = {}) {
  const onQuote = vi.fn();
  const { container } = render(
    <div data-message-id="m1">
      <span>{selected}</span>
      <QuoteSelectionToolbar onQuote={onQuote} onTangent={opts.onTangent} />
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

test("appears with Copy, Quote, and a disabled Tangent when no tangent handler is wired", async () => {
  await openToolbar("hello world");
  assert.ok(screen.getByText("Copy"));
  assert.ok(screen.getByText("Quote"));
  assert.equal(screen.getByText("Tangent").closest("button")?.disabled, true);
});

test("Tangent is enabled for a single-message selection when a handler is wired (M3)", async () => {
  const onTangent = vi.fn();
  await openToolbar("branch from this", { onTangent });
  assert.equal(screen.getByText("Tangent").closest("button")?.disabled, false);
});

test("Tangent hands the snapshot text + single source message id to onTangent (M3)", async () => {
  const onTangent = vi.fn();
  await openToolbar("seed the tangent", { onTangent });

  fireEvent.click(screen.getByText("Tangent"));
  assert.deepEqual(onTangent.mock.calls[0]?.[0], {
    text: "seed the tangent",
    sourceMessageId: "m1",
  });
});

test("Tangent fires with the snapshot after the native selection collapses (M3)", async () => {
  const onTangent = vi.fn();
  await openToolbar("captured for the tangent", { onTangent });

  collapseSelection();
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
    await flushRaf();
  });

  fireEvent.click(screen.getByText("Tangent"));
  assert.equal(onTangent.mock.calls[0]?.[0]?.text, "captured for the tangent");
});

test("Copy, Quote, and Tangent keep separate behaviors (M3)", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const onTangent = vi.fn();
  const { onQuote } = await openToolbar("shared selection", { onTangent });

  // Tangent does not copy or quote.
  fireEvent.click(screen.getByText("Tangent"));
  assert.equal(onTangent.mock.calls.length, 1);
  assert.equal(onQuote.mock.calls.length, 0);
  assert.equal(writeText.mock.calls.length, 0);
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

/** Render two adjacent messages, select across both, and release the mouse to summon the toolbar. */
async function openCrossItemToolbar(
  combined: string,
  opts: { onTangent?: TangentSpy } = {},
) {
  const onQuote = vi.fn();
  const { container } = render(
    <div>
      <div data-message-id="m1">
        <span>first message</span>
      </div>
      <div data-message-id="m2">
        <span>second message</span>
      </div>
      <QuoteSelectionToolbar onQuote={onQuote} onTangent={opts.onTangent} />
    </div>,
  );
  const m1 = container.querySelector('[data-message-id="m1"]') as Node;
  const m2 = container.querySelector('[data-message-id="m2"]') as Node;
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    anchorNode: m1,
    anchorOffset: 0,
    focusNode: m2,
    focusOffset: 0,
    toString: () => combined,
    getRangeAt: () => ({ getClientRects: () => [{ right: 50, top: 20 }] }),
    removeAllRanges: vi.fn(),
  } as unknown as Selection);

  await act(async () => {
    fireEvent.mouseUp(document.body, { clientX: 50, clientY: 20 });
    await flushRaf();
    await flushRaf();
  });
  return { onQuote };
}

test("a selection spanning two transcript items opens the toolbar (cross-item)", async () => {
  await openCrossItemToolbar("first message\nsecond message");
  // The single-message-only rule is gone: a shift-extended range across items is captured,
  // not rejected, so the toolbar is offered for it.
  assert.ok(screen.getByText("Copy"));
  assert.ok(screen.getByText("Quote"));
});

test("Tangent stays disabled for a cross-item selection even when a handler is wired (M3)", async () => {
  const onTangent = vi.fn();
  await openCrossItemToolbar("first message\nsecond message", { onTangent });
  // Copy/Quote accept cross-item ranges, but a tangent needs one source message.
  assert.ok(screen.getByText("Copy"));
  assert.equal(screen.getByText("Tangent").closest("button")?.disabled, true);
});

test("Copy writes the full cross-item text after the native selection collapses", async () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await openCrossItemToolbar("first message\nsecond message");

  collapseSelection();
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
    await flushRaf();
  });

  fireEvent.click(screen.getByText("Copy"));
  assert.equal(writeText.mock.calls[0]?.[0], "first message\nsecond message");
});

test("Quote hands the full cross-item text to the composer", async () => {
  const { onQuote } = await openCrossItemToolbar("first message\nsecond message");

  fireEvent.click(screen.getByText("Quote"));
  assert.equal(onQuote.mock.calls[0]?.[0], "first message\nsecond message");
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

test("typing in the composer does not erase the persisted selection (M2)", async () => {
  await openToolbar("keep me through typing");

  // The composer collapses the transcript selection and the user starts typing; a keystroke
  // that produces no new transcript selection must leave the stored snapshot - and toolbar -
  // untouched (only Escape or a replacement selection dismisses).
  collapseSelection();
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "a" }));
    await flushRaf();
  });
  assert.ok(screen.getByText("Copy")); // persisted through incidental typing
});

test("a wheel/trackpad scroll does not erase the persisted selection (M2)", async () => {
  await openToolbar("keep me through scroll");

  collapseSelection();
  await act(async () => {
    fireEvent.scroll(document);
    fireEvent.wheel(document.body, { deltaY: 120 });
    await flushRaf();
  });
  assert.ok(screen.getByText("Copy"));
});

test("Escape clears the persisted selection (M7)", async () => {
  await openToolbar("escape clears me");

  collapseSelection();
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
    await flushRaf();
  });
  assert.equal(screen.queryByText("Copy"), null);
});

test("starting a new selection replaces the previous one (M7)", async () => {
  const { container } = render(
    <div>
      <div data-message-id="m1">
        <span>original selection</span>
      </div>
      <div data-message-id="m2">
        <span>replacement selection</span>
      </div>
      <QuoteSelectionToolbar onQuote={vi.fn()} />
    </div>,
  );
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

  const m1 = container.querySelector('[data-message-id="m1"]') as Node;
  selectText("original selection", m1);
  await act(async () => {
    fireEvent.mouseUp(m1 as Element, { clientX: 30, clientY: 30 });
    await flushRaf();
    await flushRaf();
  });

  // A fresh drag in another item replaces the snapshot atomically.
  const m2 = container.querySelector('[data-message-id="m2"]') as Node;
  selectText("replacement selection", m2);
  await act(async () => {
    fireEvent.mouseUp(m2 as Element, { clientX: 60, clientY: 60 });
    await flushRaf();
    await flushRaf();
  });

  fireEvent.click(screen.getByText("Copy"));
  assert.equal(writeText.mock.calls.at(-1)?.[0], "replacement selection");
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

test("scroll during an unfinished mouse drag does not replace the captured selection", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const { container } = render(
    <div>
      <div data-message-id="m1">
        <span>original captured passage</span>
      </div>
      <div data-message-id="m2">
        <span>premature drag selection that starts above the intended text</span>
      </div>
      <QuoteSelectionToolbar onQuote={vi.fn()} />
    </div>,
  );

  const m1 = container.querySelector('[data-message-id="m1"]') as Node;
  selectText("original captured passage", m1);
  await act(async () => {
    fireEvent.mouseUp(m1 as Element, { clientX: 30, clientY: 30 });
    await flushRaf();
    await flushRaf();
  });
  assert.ok(screen.getByText("Copy"));

  const m2 = container.querySelector('[data-message-id="m2"]') as Node;
  await act(async () => {
    fireEvent.mouseDown(m2 as Element);
    selectText("premature drag selection that starts above the intended text", m2);
    fireEvent.scroll(document);
    await flushRaf();
    await flushRaf();
  });

  fireEvent.click(screen.getByText("Copy"));
  assert.equal(writeText.mock.calls[0]?.[0], "original captured passage");
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
