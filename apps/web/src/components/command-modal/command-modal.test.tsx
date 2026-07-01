import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import { CommandModal } from "./command-modal";
import type { CommandRow } from "./types";

const rows: CommandRow[] = [
  { id: "main", label: "main", metadata: "baseline", status: "clean", current: true },
  { id: "feat", label: "feat/x", metadata: "worktree", status: "2 agents", statusTone: "active" },
  { id: "blocked", label: "feat/wip", metadata: "worktree", disabledReason: "run active" },
];

function renderModal(over: Partial<React.ComponentProps<typeof CommandModal>> = {}) {
  const onSelect = vi.fn();
  render(
    <CommandModal
      open
      onOpenChange={() => {}}
      title="Switch worktree"
      rows={rows}
      onSelect={onSelect}
      {...over}
    />,
  );
  return { onSelect };
}

test("renders the title and every row label", () => {
  renderModal();
  assert.ok(screen.getByText("Switch worktree"));
  assert.ok(screen.getByText("main"));
  assert.ok(screen.getByText("feat/x"));
  assert.ok(screen.getByText("feat/wip"));
});

test("a disabled row shows its reason and is marked aria-disabled", () => {
  renderModal();
  const reason = screen.getByText("run active");
  assert.ok(reason);
  const item = reason.closest("[cmdk-item]");
  assert.equal(item?.getAttribute("aria-disabled"), "true");
});

test("selecting an enabled row fires onSelect with its id", () => {
  const { onSelect } = renderModal();
  fireEvent.click(screen.getByText("feat/x"));
  assert.deepEqual(onSelect.mock.calls, [["feat"]]);
});

test("clicking a disabled row never fires onSelect", () => {
  const { onSelect } = renderModal();
  fireEvent.click(screen.getByText("feat/wip"));
  assert.equal(onSelect.mock.calls.length, 0);
});

test("controlled search filters rows to matches without touching the source", () => {
  renderModal({ search: "agents" });
  assert.ok(screen.queryByText("feat/x"), "the matching row stays");
  assert.equal(screen.queryByText("main"), null, "non-matching rows drop out");
});

test("an empty row set renders the empty label", () => {
  renderModal({ rows: [], emptyLabel: "No sessions" });
  assert.ok(screen.getByText("No sessions"));
});

test("loading shows a loading state instead of rows", () => {
  renderModal({ loading: true });
  assert.ok(screen.getByText("Loading…"));
  assert.equal(screen.queryByText("main"), null);
});

test("an inventory error shows the error in place of the list", () => {
  renderModal({ error: "inventory unreachable" });
  assert.ok(screen.getByText("inventory unreachable"));
  assert.equal(screen.queryByText("main"), null);
});

test("Enter selects the highlighted row; ArrowDown moves and skips the disabled row", () => {
  const { onSelect } = renderModal();
  const input = screen.getByPlaceholderText("Search…");

  // The first enabled row is highlighted by default; Enter selects it.
  fireEvent.keyDown(input, { key: "Enter" });
  assert.deepEqual(onSelect.mock.calls.at(-1), ["main"]);

  // ArrowDown advances to the next enabled row (feat); the disabled "blocked" is skipped.
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  assert.deepEqual(onSelect.mock.calls.at(-1), ["feat"]);

  // Past the last enabled row, navigation never lands on the disabled row.
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  assert.notDeepEqual(onSelect.mock.calls.at(-1), ["blocked"]);
});

test("footer hints render (default navigate/select/close)", () => {
  renderModal();
  assert.ok(screen.getByText("navigate"));
  assert.ok(screen.getByText("select"));
  // "close" appears in both the header esc affordance and the footer hint.
  assert.ok(screen.getAllByText("close").length >= 1);
});
