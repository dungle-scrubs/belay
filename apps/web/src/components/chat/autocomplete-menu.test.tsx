import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { AutocompleteMenu } from "./autocomplete-menu";

const ROWS = Array.from({ length: 40 }, (_, i) => ({
  key: `row-${i}`,
  primary: `Row ${i}`,
}));

/**
 * The height cap is a structural contract (jsdom does not compute layout, so scrollHeight is
 * unavailable): the row listbox lives inside a bounded `overflow-y-auto` container, and the summary
 * footer is a SIBLING outside that container so it stays pinned below the scroll area.
 */
describe("AutocompleteMenu height cap", () => {
  test("wraps the listbox in a bounded overflow-y-auto scroll container", () => {
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
    // The immediate parent is the scroll container: capped and vertically scrollable.
    const scroll = listbox.parentElement;
    expect(scroll?.className).toMatch(/max-h-\[/);
    expect(scroll?.className).toContain("overflow-y-auto");
  });

  test("the summary footer is outside the scroll container so it stays pinned", () => {
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
    const scroll = listbox.parentElement; // the overflow container
    const footer = screen.getByText("40 items");
    // The footer is NOT inside the scroll container; it is a sibling of it.
    expect(scroll?.contains(footer)).toBe(false);
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

  test("a short list still wraps the listbox in the same capped container (no fixed height)", () => {
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
    const scroll = listbox.parentElement;
    // max-h (not a fixed h) so a short list renders at natural height - the cap is an upper bound only.
    expect(scroll?.className).toMatch(/max-h-\[/);
    // No standalone fixed-height class token (a leading `h-[`), only the `max-h-[` upper bound.
    const tokens = scroll?.className.split(/\s+/) ?? [];
    expect(tokens.every((token) => !token.startsWith("h-["))).toBe(true);
  });
});
