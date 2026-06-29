import { fireEvent, render, within } from "@testing-library/react";
import type { CommandMenuPayload } from "@trevor/session";
import { expect, test } from "vitest";
import { CommandMenu } from "./command-menu";

const MENU: CommandMenuPayload = {
  family: "style",
  title: "Output style",
  searchable: true,
  rows: [
    { id: "concise", label: "Concise", description: "Short answers", selected: true },
    { id: "diagnostic", label: "Diagnostic", description: "Show reasoning" },
    { id: "reset", label: "Reset to default", badge: "default" },
    {
      id: "advanced",
      label: "Advanced",
      children: [
        { id: "reviewer", label: "Reviewer" },
        { id: "explanatory", label: "Explanatory", disabledReason: "coming soon" },
      ],
    },
  ],
};

function setup(over: Partial<CommandMenuPayload> = {}) {
  const actions: Array<[string, string]> = [];
  let closed = 0;
  const result = render(
    <CommandMenu
      payload={{ ...MENU, ...over }}
      onAction={(family, id) => actions.push([family, id])}
      onClose={() => {
        closed += 1;
      }}
    />,
  );
  return { ...result, actions, closed: () => closed };
}

test("renders the root rows from host data, marking the selected one", () => {
  const { getByText, getByRole } = setup();
  expect(getByText("Concise")).toBeTruthy();
  expect(getByText("Diagnostic")).toBeTruthy();
  // The selected row carries aria-current.
  expect(getByRole("button", { name: /Concise/ }).getAttribute("aria-current")).toBe("true");
});

test("a submenu row navigates to its children, with a back affordance and breadcrumb", () => {
  const { getByText, getByRole, getByLabelText, queryByText } = setup();
  fireEvent.click(getByRole("button", { name: /Advanced/ }));

  expect(getByText("Reviewer")).toBeTruthy();
  expect(getByText("Explanatory")).toBeTruthy();
  expect(queryByText("Concise")).toBeNull(); // left the root level
  expect(getByLabelText("Breadcrumb").textContent).toContain("Advanced");

  fireEvent.click(getByLabelText("Back"));
  expect(getByText("Concise")).toBeTruthy(); // back at the root
});

test("selecting a leaf action dispatches (family, actionId) and never navigates", () => {
  const { getByRole, actions } = setup();
  fireEvent.click(getByRole("button", { name: /Diagnostic/ }));
  expect(actions).toEqual([["style", "diagnostic"]]);
});

test("a disabled row cannot be activated", () => {
  const { getByRole, actions } = setup();
  fireEvent.click(getByRole("button", { name: /Advanced/ }));
  const explanatory = getByRole("button", { name: /Explanatory/ });
  expect(explanatory.hasAttribute("disabled")).toBe(true);
  fireEvent.click(explanatory);
  expect(actions).toEqual([]); // no dispatch, no crash
});

test("search filters rows, including a submenu parent when a child matches", () => {
  const { getByLabelText, getByText, queryByText } = setup();
  fireEvent.change(getByLabelText("Search Output style"), { target: { value: "reviewer" } });
  expect(getByText("Advanced")).toBeTruthy(); // parent kept because a child matches
  expect(queryByText("Concise")).toBeNull();
});

test("an empty filtered view shows the empty text", () => {
  const { getByLabelText, getByText } = setup({ emptyText: "Nothing here." });
  fireEvent.change(getByLabelText("Search Output style"), { target: { value: "zzzzz" } });
  expect(getByText("Nothing here.")).toBeTruthy();
});

test("keyboard: Arrow keys move the highlight and Enter activates the highlighted row", () => {
  const { getByRole, actions } = setup();
  const region = getByRole("region", { name: "Output style menu" });
  fireEvent.keyDown(region, { key: "ArrowDown" }); // highlight index 1 (Diagnostic)
  fireEvent.keyDown(region, { key: "Enter" });
  expect(actions).toEqual([["style", "diagnostic"]]);
});

test("keyboard: Escape backs out of a submenu, then closes at the root", () => {
  const { getByRole, getByText, closed } = setup();
  fireEvent.click(getByRole("button", { name: /Advanced/ }));
  const region = getByRole("region", { name: "Output style menu" });
  fireEvent.keyDown(region, { key: "Escape" }); // back to root
  expect(getByText("Concise")).toBeTruthy();
  fireEvent.keyDown(region, { key: "Escape" }); // close at root
  expect(closed()).toBe(1);
});

test("exposes accessible names for the region and search (a11y)", () => {
  const { getByRole, getByLabelText } = setup();
  expect(getByRole("region", { name: "Output style menu" })).toBeTruthy();
  expect(getByLabelText("Search Output style")).toBeTruthy();
  // a non-searchable menu omits the search box.
  const plain = within(
    render(<CommandMenu payload={{ ...MENU, searchable: false }} onAction={() => {}} />).container,
  );
  expect(plain.queryByLabelText("Search Output style")).toBeNull();
});
