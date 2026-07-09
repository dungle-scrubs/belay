import assert from "node:assert/strict";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, test, vi } from "vitest";
import { useScrollFollow } from "@/hooks/use-scroll-follow";
import { LiveScrollSurface } from "./live-scroll-surface";

interface Row {
  readonly id: string;
  readonly text: string;
}

function Harness({ rows, revision }: { readonly rows: readonly Row[]; readonly revision: number }) {
  const scroll = useScrollFollow(rows.length);
  return (
    <LiveScrollSurface className="gap-2" revision={revision} scroll={scroll}>
      {rows.map((row) => (
        <div
          key={row.id}
          data-live-scroll-item
          data-live-scroll-item-id={row.id}
          style={{ minHeight: 120 }}
        >
          {row.text}
        </div>
      ))}
    </LiveScrollSurface>
  );
}

function viewport(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-live-scroll-viewport]");
  assert.ok(element);
  return element;
}

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn(function scrollTo(
    this: HTMLElement,
    options?: ScrollToOptions | number,
  ) {
    const top =
      typeof options === "number" ? options : typeof options?.top === "number" ? options.top : 0;
    this.scrollTop = top;
  });
});

test("follows appended output while pinned at the bottom", () => {
  const initialRows = [
    { id: "a", text: "alpha" },
    { id: "b", text: "bravo" },
  ] as const;
  const { rerender } = render(<Harness revision={2} rows={initialRows} />);
  const element = viewport();
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 240 },
    scrollTop: { configurable: true, writable: true, value: 40 },
  });
  act(() => {
    fireEvent.scroll(element);
  });
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 360 },
  });

  rerender(<Harness revision={3} rows={[...initialRows, { id: "c", text: "charlie" }]} />);

  assert.equal(element.scrollTop, 160);
});

test("preserves raw scroll offset while unpinned and streaming output grows", () => {
  const { rerender } = render(
    <Harness
      revision={1}
      rows={[
        { id: "a", text: "one line" },
        { id: "b", text: "two" },
      ]}
    />,
  );
  const element = viewport();
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 600 },
    scrollTop: { configurable: true, writable: true, value: 120 },
  });
  act(() => {
    fireEvent.scroll(element);
    fireEvent.wheel(element, { deltaY: -40 });
  });
  element.scrollTop = 180;

  rerender(
    <Harness
      revision={2}
      rows={[
        {
          id: "a",
          text: "one line\nstreamed line\nstreamed line\nstreamed line",
        },
        { id: "b", text: "two" },
      ]}
    />,
  );

  assert.equal(element.scrollTop, 120);
});

test("shows the shared jump control when unpinned and repins on click", () => {
  render(
    <Harness
      revision={2}
      rows={[
        { id: "a", text: "alpha" },
        { id: "b", text: "bravo" },
      ]}
    />,
  );
  const element = viewport();
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 500 },
    scrollTop: { configurable: true, writable: true, value: 100 },
  });

  act(() => {
    fireEvent.scroll(element);
    fireEvent.wheel(element, { deltaY: -40 });
  });
  const button = screen.getByRole("button", { name: "Scroll to bottom" });
  fireEvent.click(button);

  assert.equal(element.scrollTop, 300);
  assert.equal(screen.queryByRole("button", { name: "Scroll to bottom" }), null);
});
