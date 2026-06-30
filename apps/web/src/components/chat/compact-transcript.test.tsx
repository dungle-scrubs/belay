import assert from "node:assert/strict";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import type { Message } from "../../transcript";
import type { TranscriptRow } from "../../transcript-rows";
import { TranscriptRowView } from "./transcript-row-view";

/**
 * M3: the transcript-level compact toggle. Proves an eligible row collapses to a one-line CompactRow
 * while user prompts + final assistant responses stay full, that the detail expands to the SAME full
 * renderer, and that compact mode is display-only - it never changes a row's message id (key) or
 * mutates the message.
 */

const noop = () => {};

function messageRow(message: Message): TranscriptRow {
  return { kind: "message", id: `message:${message.id}`, message, compactAbove: false };
}

function renderRow(
  row: TranscriptRow,
  over?: {
    compact?: boolean;
    expandedRows?: ReadonlySet<string>;
    onToggleRow?: (id: string) => void;
  },
) {
  return render(
    <TranscriptRowView
      row={row}
      showThinking
      onOpenPath={noop}
      onDoctorRefresh={noop}
      compact={over?.compact ?? false}
      expandedRows={over?.expandedRows}
      onToggleRow={over?.onToggleRow}
    />,
  );
}

const toolMsg: Message = {
  kind: "tool",
  id: "t1",
  name: "bash",
  args: JSON.stringify({ command: "ls -la" }),
  done: true,
  result: "total 0\nfile.txt",
};

test("compact mode collapses an eligible row to a one-line row with an expand affordance", () => {
  const { getByRole, getByText } = renderRow(messageRow(toolMsg), {
    compact: true,
    expandedRows: new Set(),
    onToggleRow: noop,
  });
  getByText("bash");
  // Detail-eligible (it has a result) -> the compact row is an expand button.
  getByRole("button");
});

test("user prompts and final assistant responses stay full in compact mode (no compact row)", () => {
  const user = renderRow(
    messageRow({ kind: "user", id: "u1", text: "hello world", artifacts: [], pastes: [] }),
    { compact: true, expandedRows: new Set(), onToggleRow: noop },
  );
  user.getByText("hello world");
  assert.equal(user.queryByRole("button"), null);

  const response = renderRow(
    messageRow({
      kind: "assistant",
      id: "a1",
      runId: "r1",
      text: "Here is the answer.",
      thinking: "",
      done: true,
      warm: false,
      model: "glm",
    }),
    { compact: true, expandedRows: new Set(), onToggleRow: noop },
  );
  response.getByText("Here is the answer.");
  assert.equal(response.queryByRole("button"), null);
});

test("expanding a compact row reveals the same full renderer as the detail", () => {
  const collapsed = renderRow(messageRow(toolMsg), {
    compact: true,
    expandedRows: new Set(),
    onToggleRow: noop,
  });
  // Collapsed: the full tool output is not shown.
  assert.equal(collapsed.queryByText(/file\.txt/), null);

  const expanded = renderRow(messageRow(toolMsg), {
    compact: true,
    expandedRows: new Set(["t1"]),
    onToggleRow: noop,
  });
  // Expanded: the recursive full ToolRenderer renders the output.
  assert.ok(expanded.queryByText(/file\.txt/));
});

test("toggling a compact row calls onToggleRow with the message id", () => {
  const toggled: string[] = [];
  const { getByRole } = renderRow(messageRow(toolMsg), {
    compact: true,
    expandedRows: new Set(),
    onToggleRow: (id) => toggled.push(id),
  });
  fireEvent.click(getByRole("button"));
  assert.deepEqual(toggled, ["t1"]);
});

test("compact mode is display-only: it does not mutate the message", () => {
  const message: Message = { ...toolMsg };
  const snapshot = JSON.stringify(message);
  renderRow(messageRow(message), {
    compact: true,
    expandedRows: new Set(["t1"]),
    onToggleRow: noop,
  });
  assert.equal(JSON.stringify(message), snapshot, "the message object is untouched");
});

test("the row's message id (key) is the same whether compact or not", () => {
  const row = messageRow(toolMsg);
  const full = renderRow(row, { compact: false });
  const compact = renderRow(row, { compact: true, expandedRows: new Set(), onToggleRow: noop });
  assert.ok(full.container.querySelector('[data-message-id="t1"]'), "full keeps the id");
  assert.ok(compact.container.querySelector('[data-message-id="t1"]'), "compact keeps the id");
});
