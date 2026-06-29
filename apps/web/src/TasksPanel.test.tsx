import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import type { TaskSnapshot, TaskStatus } from "@trevor/session";
import { test } from "vitest";
import { TasksPanel } from "@/TasksPanel";

/**
 * The header task panel (TasksPanel). It is purely presentational over a task snapshot: it orders
 * by status, caps the visible rows at five, coalesces a burst of low-priority tasks into grouped
 * rows, and shows an overflow row when work is hidden - while the header count always reflects the
 * full list (plan 09). Freshness/selection lives in derivation, not here.
 */

let id = 0;
const task = (
  status: TaskStatus,
  activeForm: string,
  over: Partial<TaskSnapshot> = {},
): TaskSnapshot => {
  id += 1;
  return {
    id: `task_${id}`,
    subject: activeForm,
    activeForm,
    status,
    blockedBy: [],
    blocks: [],
    ...over,
  };
};

// M2 characterization: today the panel renders every task in snapshot order with no cap. This pins
// the gap M4 replaces (the cap, ordering, grouping, and overflow row).
test("renders a task's activeForm and a full-list done/total header", () => {
  render(
    <TasksPanel tasks={[task("completed", "first done"), task("in_progress", "doing second")]} />,
  );

  assert.ok(screen.getByText("doing second"));
  assert.ok(screen.getByText("first done"));
  assert.ok(screen.getByText("tasks 1/2"));
});

test("renders nothing for an empty checklist", () => {
  const { container } = render(<TasksPanel tasks={[]} />);
  assert.equal(container.firstChild, null);
});
