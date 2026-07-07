import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { AutocompleteMenu } from "./autocomplete-menu";

const ROWS = Array.from({ length: 40 }, (_, i) => ({
  key: `row-${i}`,
  primary: `Row ${i}`,
}));

/**
 * The height cap is a structural contract (jsdom does not compute layout, so scrollHeight is
 * unavailable): the listbox itself is the capped `overflow-y-auto` scroll container, and the summary
 * footer is a SIBLING outside it so it stays pinned below the scroll area.
 */
describe("AutocompleteMenu height cap", () => {
  test("the listbox is a bounded overflow-y-auto scroll container", () => {
    render(
      <AutocompleteMenu
        rows={ROWS}
        activeIndex={0}
        onPick={vi.fn()}
        ariaLabel="Items"
        listboxId="test-list"
      />,
    );
    const listbox = screen.getByRole("listbox");
    // The listbox carries the cap and is vertically scrollable.
    expect(listbox.className).toMatch(/max-h-\[/);
    expect(listbox.className).toContain("overflow-y-auto");
  });

  test("the summary footer is a sibling of the listbox so it stays pinned", () => {
    render(
      <AutocompleteMenu
        rows={ROWS}
        activeIndex={0}
        onPick={vi.fn()}
        ariaLabel="Items"
        listboxId="test-list"
        summary="40 items"
      />,
    );
    const listbox = screen.getByRole("listbox");
    const footer = screen.getByText("40 items");
    // The footer is NOT inside the scrollable listbox; it is a sibling of it.
    expect(listbox.contains(footer)).toBe(false);
  });

  test("an empty state renders without a scroll container or listbox", () => {
    render(
      <AutocompleteMenu
        rows={[]}
        activeIndex={0}
        onPick={vi.fn()}
        ariaLabel="Items"
        listboxId="test-list"
        empty="Nothing here"
      />,
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("Nothing here")).toBeTruthy();
  });

  test("a short list still carries the cap (no fixed height)", () => {
    render(
      <AutocompleteMenu
        rows={[{ key: "only", primary: "Only" }]}
        activeIndex={0}
        onPick={vi.fn()}
        ariaLabel="Items"
        listboxId="test-list"
      />,
    );
    const listbox = screen.getByRole("listbox");
    // max-h (not a fixed h) so a short list renders at natural height - the cap is an upper bound only.
    expect(listbox.className).toMatch(/max-h-\[/);
    const tokens = listbox.className.split(/\s+/);
    expect(tokens.every((token) => !token.startsWith("h-["))).toBe(true);
  });
});
