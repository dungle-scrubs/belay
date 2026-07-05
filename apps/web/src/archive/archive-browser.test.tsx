import assert from "node:assert/strict";
import { fireEvent, render, within } from "@testing-library/react";
import { test } from "vitest";
import { ArchiveBrowser, DELETE_CONFIRM_PHRASE } from "./archive-browser";
import type { ArchivedSessionRow } from "./archive-rows";

const NOW = Date.parse("2026-06-29T12:00:00.000Z");

function row(over: Partial<ArchivedSessionRow> & { sessionId: string }): ArchivedSessionRow {
  return {
    title: `Session ${over.sessionId}`,
    project: "trevor",
    cwd: "~/dev/trevor",
    updatedAt: "2026-06-29T09:00:00.000Z",
    eventCount: 42,
    protectedReason: null,
    ...over,
  };
}

const ROWS = [
  row({ sessionId: "a", title: "Refactor the turn loop" }),
  row({ sessionId: "b", title: "Investigate flaky e2e" }),
];

test("renders one row per archived session with its metadata", () => {
  const { getByText, getAllByRole } = render(
    <ArchiveBrowser rows={ROWS} nowMs={NOW} onUnarchive={() => {}} onDelete={() => {}} />,
  );
  getByText("Refactor the turn loop");
  getByText("Investigate flaky e2e");
  // Two unarchive buttons, one per row.
  assert.equal(getAllByRole("button", { name: "Unarchive" }).length, 2);
});

test("the empty state explains how archived sessions appear", () => {
  const { getByText } = render(
    <ArchiveBrowser rows={[]} nowMs={NOW} onUnarchive={() => {}} onDelete={() => {}} />,
  );
  getByText("No archived sessions");
});

test("the back arrow returns to chat without mutating any session", () => {
  let backed = 0;
  let mutations = 0;
  const { getByLabelText } = render(
    <ArchiveBrowser
      rows={ROWS}
      nowMs={NOW}
      onBack={() => backed++}
      onUnarchive={() => mutations++}
      onDelete={() => mutations++}
    />,
  );
  fireEvent.click(getByLabelText("Back to chat"));
  assert.equal(backed, 1);
  assert.equal(mutations, 0);
});

test("unarchive fires the action for that row's session id", () => {
  const unarchived: string[] = [];
  const { getAllByRole } = render(
    <ArchiveBrowser
      rows={ROWS}
      nowMs={NOW}
      onUnarchive={(id) => unarchived.push(id)}
      onDelete={() => {}}
    />,
  );
  const [firstUnarchive] = getAllByRole("button", { name: "Unarchive" });
  fireEvent.click(firstUnarchive as HTMLElement);
  assert.deepEqual(unarchived, ["a"]);
});

test("a protected row cannot be deleted (the delete affordance is disabled with a reason)", () => {
  const { getAllByRole } = render(
    <ArchiveBrowser
      rows={[row({ sessionId: "live", protectedReason: "a host is live on this session" })]}
      nowMs={NOW}
      onUnarchive={() => {}}
      onDelete={() => {}}
    />,
  );
  const [del] = getAllByRole("button", { name: "Permanently delete" });
  assert.equal((del as HTMLButtonElement).disabled, true);
  assert.equal((del as HTMLButtonElement).title, "a host is live on this session");
});

test("delete requires the typed phrase: an incomplete value cannot confirm by click or Enter", () => {
  const deleted: string[] = [];
  const { getAllByRole, getByLabelText, getByRole } = render(
    <ArchiveBrowser
      rows={ROWS}
      nowMs={NOW}
      onUnarchive={() => {}}
      onDelete={(id) => deleted.push(id)}
    />,
  );
  fireEvent.click(getAllByRole("button", { name: "Permanently delete" })[0] as HTMLElement);

  const confirm = getByRole("button", { name: "Delete forever" }) as HTMLButtonElement;
  assert.equal(confirm.disabled, true, "confirm is disabled before the phrase is typed");

  const input = getByLabelText(`Type ${DELETE_CONFIRM_PHRASE} to confirm permanent deletion`);
  // A wrong value keeps it disabled, and Enter does nothing.
  fireEvent.change(input, { target: { value: "del" } });
  assert.equal(confirm.disabled, true);
  fireEvent.keyDown(input, { key: "Enter" });
  assert.deepEqual(deleted, []);

  // The exact phrase arms it; Enter then confirms.
  fireEvent.change(input, { target: { value: DELETE_CONFIRM_PHRASE } });
  assert.equal(confirm.disabled, false);
  fireEvent.keyDown(input, { key: "Enter" });
  assert.deepEqual(deleted, ["a"]);
});

test("clicking the armed confirm button deletes, and cancel closes without deleting", () => {
  const deleted: string[] = [];
  const { getAllByRole, getByLabelText, getByRole, queryByRole } = render(
    <ArchiveBrowser
      rows={ROWS}
      nowMs={NOW}
      onUnarchive={() => {}}
      onDelete={(id) => deleted.push(id)}
    />,
  );

  // Open, cancel -> no delete, panel closes.
  fireEvent.click(getAllByRole("button", { name: "Permanently delete" })[0] as HTMLElement);
  fireEvent.click(getByRole("button", { name: "Cancel" }));
  assert.equal(queryByRole("button", { name: "Delete forever" }), null);
  assert.deepEqual(deleted, []);

  // Re-open, type the phrase, click confirm.
  fireEvent.click(getAllByRole("button", { name: "Permanently delete" })[0] as HTMLElement);
  fireEvent.change(getByLabelText(`Type ${DELETE_CONFIRM_PHRASE} to confirm permanent deletion`), {
    target: { value: DELETE_CONFIRM_PHRASE },
  });
  fireEvent.click(getByRole("button", { name: "Delete forever" }));
  assert.deepEqual(deleted, ["a"]);
});

test("a delete confirmation seeded open names the session it will delete", () => {
  const { getByRole } = render(
    <ArchiveBrowser
      rows={ROWS}
      nowMs={NOW}
      defaultConfirmingId="b"
      onUnarchive={() => {}}
      onDelete={() => {}}
    />,
  );
  // The destructive panel is a labeled group naming the exact session, so the gesture is unmistakable.
  const panel = getByRole("group", {
    name: "Confirm permanent deletion of Investigate flaky e2e",
  });
  within(panel).getByText(/cannot be undone/i);
});

test("a per-row error renders row-scoped without removing the other rows", () => {
  const { getByText } = render(
    <ArchiveBrowser
      rows={ROWS}
      nowMs={NOW}
      actionState={{ a: { kind: "error", message: "Delete failed - store rejected it." } }}
      onUnarchive={() => {}}
      onDelete={() => {}}
    />,
  );
  getByText("Delete failed - store rejected it.");
  // The other row is untouched.
  getByText("Investigate flaky e2e");
});
