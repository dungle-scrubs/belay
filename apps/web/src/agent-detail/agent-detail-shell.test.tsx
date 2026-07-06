import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test } from "vitest";
import type { Message } from "@/transcript";
import type { TranscriptRow } from "@/transcript-rows";
import { AgentDetailShell } from "./agent-detail-shell";

/**
 * Plan 09.4 M6: the inline-agent detail takeover renders a delegated child's OWN transcript through the
 * shared row components, names the agent, and returns to the parent chat via the shared back button.
 * A terminal child shows its final answer; an empty child shows a clear placeholder, not a blank void.
 */

const NOOP = () => {};

const messageRow = (id: string, message: Message): TranscriptRow => ({
  kind: "message",
  id: `message:${id}`,
  compactAbove: false,
  message,
});

const doneRows: readonly TranscriptRow[] = [
  messageRow("u", {
    kind: "user",
    id: "u",
    text: "search for the failing assertion",
    artifacts: [],
    pastes: [],
  }),
  messageRow("a", {
    kind: "assistant",
    id: "a",
    runId: "cr1",
    text: "The failing assertion is in src/auth.ts:42.",
    thinking: "",
    done: true,
    warm: true,
    model: "qwen3",
  }),
];

test("the takeover renders the child's transcript with an agent-named header (M6)", () => {
  render(<AgentDetailShell agent="explorer" rows={doneRows} onBack={NOOP} onOpenPath={NOOP} />);
  assert.ok(screen.getByText("search for the failing assertion"), "the child's task prompt");
  assert.ok(
    screen.getByText(/The failing assertion is in src\/auth\.ts:42/),
    "the child's final answer",
  );
  assert.ok(screen.getByText(/explorer/), "the header names the agent");
});

test("the back button returns to the parent chat (M6)", () => {
  let backed = 0;
  render(
    <AgentDetailShell
      agent="explorer"
      rows={doneRows}
      onBack={() => {
        backed += 1;
      }}
      onOpenPath={NOOP}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
  assert.equal(backed, 1);
});

test("an empty child shows a clear placeholder, not a blank void (M6)", () => {
  render(<AgentDetailShell agent="planner" rows={[]} onBack={NOOP} onOpenPath={NOOP} />);
  assert.ok(screen.getByText(/hasn't produced any output/));
});
