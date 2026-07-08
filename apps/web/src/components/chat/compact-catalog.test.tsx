import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import { test } from "vitest";
import { reconnectActionLabel } from "@/action-label";
import { readOnlyToolBatches } from "../../transcript";
import { buildTranscriptRows } from "../../transcript-rows";
import { CATALOG_KINDS, catalogActive, catalogTranscript } from "./compact-catalog-fixtures";
import { compactDisplayFor } from "./compact-display";
import { compactTypeKey } from "./compact-spacing";
import { toolMessageStatus } from "./tool-status";
import { TranscriptRowView } from "./transcript-row-view";

/**
 * M2 (plan 58): the all-types compact catalog. Proves the fixtures cover every `Message.kind` and every
 * tool type-variant, that each compact-eligible item projects to (and renders as) a one-line compact
 * row while the primacy kinds stay full, and that the resting + active states are both represented.
 */

const noop = () => {};

test("the catalog covers every Message.kind", () => {
  const transcript = catalogTranscript();
  for (const kind of CATALOG_KINDS) {
    assert.ok(
      transcript.some((message) => message.kind === kind),
      `catalog is missing a fixture for kind "${kind}"`,
    );
  }
});

test("the catalog includes every tool type-variant the spacing rule distinguishes", () => {
  const transcript = catalogTranscript();
  const toolNames = transcript.flatMap((m) => (m.kind === "tool" ? [m.name] : []));

  // A read-only run of 2+ consecutive read-only tools folds into a concurrent batch (one readonly type).
  const batches = readOnlyToolBatches(transcript);
  assert.ok(batches.batchAt.size >= 1, "expected a read-only tool batch (read/glob/grep)");

  // Two distinct mutating tools (each its own type).
  assert.ok(toolNames.includes("edit"));
  assert.ok(toolNames.includes("write"));
  assert.ok(toolNames.includes("bash"));

  // Two same-named mutating calls (edit, edit) share a type key.
  assert.equal(toolNames.filter((name) => name === "edit").length, 2);

  // At least one MCP tool, keyed as its own mcp type (never the readonly bucket).
  const mcpTool = transcript.find(
    (m) => m.kind === "tool" && compactTypeKey(rowFor(m)).startsWith("mcp:"),
  );
  assert.ok(mcpTool, "expected an MCP tool fixture");
});

test("every collapsible item projects to a one-line compact display; the rest stay full", () => {
  const full = new Set<string>();
  for (const message of catalogTranscript()) {
    const display = compactDisplayFor(message);
    if (display === null) {
      full.add(message.kind);
      continue;
    }
    assert.ok(display.primary.length > 0, `${message.kind} needs a primary label`);
  }
  // The kinds that keep their full render in compact mode: user prompts, assistant responses, and
  // inline-agent delegations whose child rows stay independently clickable (plan 58.1).
  assert.deepEqual(full, new Set(["user", "assistant", "inlineAgent"]));
});

test("each collapsible catalog row renders through the real compact path as one line", () => {
  for (const message of catalogTranscript()) {
    const display = compactDisplayFor(message);
    if (display === null) {
      continue;
    }
    const { container, getAllByText, unmount } = render(
      <TranscriptRowView
        row={rowFor(message)}
        showThinking
        onOpenPath={noop}
        onDoctorRefresh={noop}
        compact
        expandedRows={new Set()}
        onToggleRow={noop}
      />,
    );
    // The compact row is a single h-6 line carrying the display's primary label.
    assert.ok(
      container.querySelector(".h-6"),
      `${message.kind} should render a one-line compact row`,
    );
    assert.ok(
      getAllByText(display.primary).length >= 1,
      `${message.kind} should show its primary label`,
    );
    unmount();
  }
});

test("resting and active states are both represented", () => {
  const resting = catalogTranscript();
  // Resting: a settled (done) tool, a settled thought, and a completed delegation.
  assert.ok(
    resting.some((m) => m.kind === "tool" && toolMessageStatus(m) === "done"),
    "expected a settled tool",
  );
  assert.ok(
    resting.some((m) => m.kind === "assistant" && !m.text && m.done),
    "expected a settled thought",
  );
  assert.ok(
    resting.some((m) => m.kind === "delegation" && m.status === "done"),
    "expected a completed delegation",
  );

  const active = catalogActive();
  // Active: a running tool (spinner), a streaming thought, and a running delegation.
  assert.ok(
    active.some((m) => m.kind === "tool" && toolMessageStatus(m) === "running"),
    "expected a running tool",
  );
  assert.ok(
    active.some(
      (m) => m.kind === "assistant" && !m.done && compactDisplayFor(m)?.status === "running",
    ),
    "expected a streaming assistant",
  );
  assert.ok(
    active.some((m) => m.kind === "delegation" && m.status === "running"),
    "expected a running delegation",
  );
});

test("58.1 M4: catalog includes the latest-attempt reconnecting state without raw markup", () => {
  const reconnecting = catalogActive().find((m) => m.kind === "reconnecting");
  assert.ok(reconnecting, "expected an active reconnecting fixture");
  const display = compactDisplayFor(reconnecting);
  assert.equal(display?.secondary, `${reconnectActionLabel(2, 10)} · 502 Bad Gateway`);
  assert.doesNotMatch(display?.secondary ?? "", /<html>|<body>|ZenZG/);
});

test("the catalog's read-only run batches while same-name and distinct tools group by type", () => {
  const transcript = catalogTranscript();
  const rows = buildTranscriptRows({ transcript, toolBatches: readOnlyToolBatches(transcript) });

  // The read/glob/grep run is a single tool_batch row of 3 read-only tools.
  const batch = rows.find((row) => row.kind === "tool_batch");
  assert.ok(batch && batch.kind === "tool_batch");
  assert.equal(batch.tools.length, 3);

  // Both edit calls survive as their own message rows and share the "tool:edit" type key.
  const editRows = rows.filter(
    (row) => row.kind === "message" && row.message.kind === "tool" && row.message.name === "edit",
  );
  const [firstEdit, secondEdit] = editRows;
  assert.ok(firstEdit && secondEdit, "expected two edit rows");
  assert.equal(compactTypeKey(firstEdit), "tool:edit");
  assert.equal(compactTypeKey(secondEdit), "tool:edit");
});

test("every catalog item renders in full (non-compact) mode without crashing", () => {
  for (const message of catalogTranscript()) {
    const { container, unmount } = render(
      <TranscriptRowView
        row={rowFor(message)}
        showThinking
        onOpenPath={noop}
        onDoctorRefresh={noop}
        onOpenArtifact={noop}
        onMenuAction={noop}
        onOpenDetail={noop}
        onOpenAgent={noop}
      />,
    );
    assert.ok(container.firstChild, `${message.kind} should render a full row`);
    unmount();
  }
});

/** Wraps a message as a plain (non-batched) message row for a type-key lookup. */
function rowFor(message: ReturnType<typeof catalogTranscript>[number]) {
  return { kind: "message", id: `message:${message.id}`, message, compactAbove: false } as const;
}
