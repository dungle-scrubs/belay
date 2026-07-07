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
    onOpenDetail?: (message: Message) => void;
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
      onOpenDetail={over?.onOpenDetail}
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

const thoughtMsg: Message = {
  kind: "assistant",
  id: "a-thought",
  runId: "r1",
  text: "",
  thinking: "Inspect the files before editing.\nThen run tests.",
  done: true,
  warm: false,
  model: "glm",
};

const resultMsg: Message = {
  kind: "result",
  id: "r1",
  command: "doctor",
  text: "all green\n3 checks passed",
  ok: true,
};

test("compact mode collapses a tool row to one line and uses detail inspection, not inline expansion", () => {
  const opened: Message[] = [];
  const { getByRole, getByText } = renderRow(messageRow(toolMsg), {
    compact: true,
    expandedRows: new Set(),
    onOpenDetail: (message) => opened.push(message),
    onToggleRow: () => {
      throw new Error("tool rows should not inline-expand in compact mode");
    },
  });
  getByText("bash");
  fireEvent.click(getByRole("button", { name: /inspect tool detail/i }));
  assert.deepEqual(opened, [toolMsg]);
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
  const collapsed = renderRow(messageRow(resultMsg), {
    compact: true,
    expandedRows: new Set(),
    onToggleRow: noop,
  });
  // Collapsed: only the one-line summary is shown.
  assert.equal(collapsed.queryByText(/3 checks passed/), null);

  const expanded = renderRow(messageRow(resultMsg), {
    compact: true,
    expandedRows: new Set(["r1"]),
    onToggleRow: noop,
  });
  // Expanded: the recursive full renderer shows the full command output.
  assert.ok(expanded.queryByText(/3 checks passed/));
});

test("toggling a compact row calls onToggleRow with the message id", () => {
  const toggled: string[] = [];
  const { getByRole } = renderRow(messageRow(thoughtMsg), {
    compact: true,
    expandedRows: new Set(),
    onToggleRow: (id) => toggled.push(id),
  });
  fireEvent.click(getByRole("button"));
  assert.deepEqual(toggled, ["a-thought"]);
});

test("expanding a compact thinking row reveals one detail depth without nesting another thinking trigger", () => {
  const expanded = renderRow(messageRow(thoughtMsg), {
    compact: true,
    expandedRows: new Set(["a-thought"]),
    onToggleRow: noop,
  });
  assert.equal(expanded.getAllByText("Thought").length, 1);
  assert.equal(expanded.queryByText("thinking"), null);
  assert.ok(expanded.queryByText(/Then run tests\./));
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

test("exactly one element carries the message id in every compact state (selection integrity)", () => {
  const row = messageRow(thoughtMsg);
  const collapsed = renderRow(row, { compact: true, expandedRows: new Set(), onToggleRow: noop });
  assert.equal(
    collapsed.container.querySelectorAll('[data-message-id="a-thought"]').length,
    1,
    "collapsed: one id (the compact wrapper)",
  );
  const expanded = renderRow(row, {
    compact: true,
    expandedRows: new Set(["a-thought"]),
    onToggleRow: noop,
  });
  assert.equal(
    expanded.container.querySelectorAll('[data-message-id="a-thought"]').length,
    1,
    "expanded: one id (the inner full render, not a duplicate)",
  );
});
