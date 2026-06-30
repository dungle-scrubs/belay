import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { test, vi } from "vitest";
import type { Message } from "@/transcript";
import { WithInspect } from "./inspect-affordance";

/**
 * M5: the inspect affordance that opens a row's detail takeover. Only a detail-eligible row (tool / shell)
 * gets the button - non-eligible rows are never cluttered - and clicking it dispatches the source message.
 */

const tool: Message = { kind: "tool", id: "c1", name: "bash", args: "{}", done: true };
const user: Message = { kind: "user", id: "u1", text: "hi", artifacts: [], pastes: [] };

test("an eligible row shows the inspect button and dispatches its message", () => {
  const onOpenDetail = vi.fn();
  render(
    <WithInspect message={tool} onOpenDetail={onOpenDetail}>
      <div>row body</div>
    </WithInspect>,
  );
  assert.ok(screen.getByText("row body"), "the row content still renders");
  fireEvent.click(screen.getByLabelText("Inspect tool detail"));
  assert.deepEqual(onOpenDetail.mock.calls, [[tool]]);
});

test("a non-eligible row (user prompt) is not cluttered with an inspect button", () => {
  render(
    <WithInspect message={user} onOpenDetail={vi.fn()}>
      <div>prompt</div>
    </WithInspect>,
  );
  assert.ok(screen.getByText("prompt"));
  assert.equal(screen.queryByLabelText("Inspect tool detail"), null);
});

test("with no onOpenDetail wired, the row renders exactly as before (no button)", () => {
  render(
    <WithInspect message={tool}>
      <div>row body</div>
    </WithInspect>,
  );
  assert.equal(screen.queryByLabelText("Inspect tool detail"), null);
});
