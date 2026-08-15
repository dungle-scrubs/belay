import type { FileMatch } from "@belay/session";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { FileMentionMenu } from "./file-mention-menu";

const MATCHES: FileMatch[] = [
  { path: "apps/web/src/app.tsx" },
  { path: "apps/web/src/hooks/use-composer.ts" },
  { path: "README.md" },
];

describe("FileMentionMenu", () => {
  test("marks the active row with aria-selected and lists one option per match", () => {
    render(<FileMentionMenu matches={MATCHES} activeIndex={1} query="use" onPick={vi.fn()} />);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    const selected = options.map((option) => option.getAttribute("aria-selected"));
    expect(selected).toEqual(["false", "true", "false"]);
  });

  test("emphasizes the basename and shows the directory muted", () => {
    render(<FileMentionMenu matches={MATCHES} activeIndex={0} query="" onPick={vi.fn()} />);
    // The basename is the visible primary text; the directory is shown separately.
    expect(screen.getByText("app.tsx")).toBeTruthy();
    expect(screen.getByText("apps/web/src")).toBeTruthy();
    // A root-level file has no directory portion to render.
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  test("picks a path via mouseDown and prevents default so the composer keeps focus", () => {
    const onPick = vi.fn();
    render(<FileMentionMenu matches={MATCHES} activeIndex={0} query="" onPick={onPick} />);
    const option = screen.getByText("use-composer.ts").closest("button");
    expect(option).toBeTruthy();
    // fireEvent returns false when the handler called preventDefault (focus stays in the textarea).
    const notCancelled = fireEvent.mouseDown(option as HTMLElement);
    expect(notCancelled).toBe(false);
    expect(onPick).toHaveBeenCalledWith("apps/web/src/hooks/use-composer.ts");
  });

  test("truncates a long directory rather than wrapping the row", () => {
    const long: FileMatch[] = [
      { path: "apps/web/src/components/chat/loop/really/deep/nesting/handler.tsx" },
    ];
    render(<FileMentionMenu matches={long} activeIndex={0} query="handler" onPick={vi.fn()} />);
    const dir = screen.getByText("apps/web/src/components/chat/loop/really/deep/nesting");
    expect(dir.className).toContain("truncate");
  });

  test("shows a result-count summary, and a truncation notice when capped", () => {
    const { rerender } = render(
      <FileMentionMenu matches={MATCHES} activeIndex={0} query="" onPick={vi.fn()} />,
    );
    expect(screen.getByText(/3 files/i)).toBeTruthy();

    rerender(
      <FileMentionMenu matches={MATCHES} activeIndex={0} query="" onPick={vi.fn()} truncated />,
    );
    expect(screen.getByText(/more/i)).toBeTruthy();
  });

  test("renders an empty state when there are no matches", () => {
    render(<FileMentionMenu matches={[]} activeIndex={0} query="zzz" onPick={vi.fn()} />);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/no.*files/i)).toBeTruthy();
  });
});
