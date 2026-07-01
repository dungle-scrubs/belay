import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import type { TaskSnapshot, TaskStatus } from "@trevor/session";
import { test } from "vitest";
import { TasksPanel } from "@/tasks-panel";

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

// --- M4: cap, ordering, grouping, overflow ---

test("caps the visible rows at five and shows a `...N more` overflow line", () => {
  const tasks = [
    task("in_progress", "row-1"),
    task("pending", "pending-a"),
    task("pending", "pending-b"),
    task("completed", "done-a"),
    task("completed", "done-b"),
    task("completed", "done-c"),
  ];

  render(<TasksPanel tasks={tasks} />);

  // Six tasks, five visible task rows, the lowest-priority one hidden -> "...1 more".
  assert.ok(screen.getByText("...1 more"));
  assert.ok(screen.getByText("row-1"));
  assert.equal(screen.queryByText("done-c"), null);
  // The header counts the FULL list, not the visible rows.
  assert.ok(screen.getByText("tasks 3/6"));
});

test("a 10-15 task burst coalesces lower-priority work into grouped rows", () => {
  const tasks = [
    task("in_progress", "wiring the API"),
    ...Array.from({ length: 8 }, (_, i) => task("pending", `pending-${i}`)),
    ...Array.from({ length: 5 }, (_, i) => task("completed", `done-${i}`)),
    task("failed", "failed-1"),
    task("failed", "failed-2"),
  ];

  render(<TasksPanel tasks={tasks} />);

  assert.ok(screen.getByText("wiring the API"));
  assert.ok(screen.getByText("8 upcoming tasks"));
  assert.ok(screen.getByText("5 completed / 2 failed"));
  // No individual pending/terminal row leaks through, and the burst needs no overflow line.
  assert.equal(screen.queryByText("pending-0"), null);
  assert.equal(screen.queryByText("done-0"), null);
  assert.equal(screen.queryByText(/more$/), null);
  // Header still reflects the full list of 16 tasks (5 completed of 16).
  assert.ok(screen.getByText("tasks 5/16"));
});

test("active and pending tasks are visible before terminal states", () => {
  const tasks = [
    task("completed", "done-a"),
    task("completed", "done-b"),
    task("in_progress", "active-a"),
    task("pending", "pending-a"),
    task("pending", "pending-b"),
    task("cancelled", "cancelled-a"),
  ];

  render(<TasksPanel tasks={tasks} />);

  // The highest-priority five are visible; a terminal task is the hidden remainder.
  assert.ok(screen.getByText("active-a"));
  assert.ok(screen.getByText("pending-a"));
  assert.ok(screen.getByText("pending-b"));
  assert.ok(screen.getByText("...1 more"));
});

// M8: a long list renders individual active rows, a coalesced group row, AND an overflow line at once.
test("renders active rows, a group row, and an overflow line together for a long list", () => {
  const tasks = [
    ...Array.from({ length: 4 }, (_, i) => task("in_progress", `running-${i}`)),
    ...Array.from({ length: 6 }, (_, i) => task("pending", `queued-${i}`)),
    ...Array.from({ length: 3 }, (_, i) => task("completed", `finished-${i}`)),
  ];

  render(<TasksPanel tasks={tasks} />);

  // Four active tasks individual, the pending bucket grouped, the terminal bucket overflowed.
  assert.ok(screen.getByText("running-0"));
  assert.ok(screen.getByText("running-3"));
  assert.ok(screen.getByText("6 upcoming tasks"));
  assert.ok(screen.getByText("...3 more"));
  // No pending task leaks through as an individual row, and the header counts all 13 tasks.
  assert.equal(screen.queryByText("queued-0"), null);
  assert.ok(screen.getByText("tasks 3/13"));
});
