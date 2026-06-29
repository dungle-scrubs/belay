import assert from "node:assert/strict";
import type { TaskSnapshot, TaskStatus } from "@trevor/session";
import { test } from "vitest";
import { buildTaskDisplay, orderTasks, type TaskDisplayRow } from "./tasks-display";

/**
 * The compact task-panel display model (plan 09 M3/M4): ordering, the five-row cap, burst grouping,
 * and the overflow count. Pure functions, tested without a DOM. The model-facing checklist is never
 * truncated, so none of this affects the prompt - that invariant is pinned host-side. <!-- D-002 D-003 D-008 -->
 */

let id = 0;
function task(status: TaskStatus, activeForm: string = status): TaskSnapshot {
  id += 1;
  return { id: `task_${id}`, subject: activeForm, activeForm, status, blockedBy: [], blocks: [] };
}

const forms = (rows: readonly TaskDisplayRow[]): string[] =>
  rows.flatMap((row) => (row.kind === "task" ? [row.task.activeForm] : []));

const labels = (rows: readonly TaskDisplayRow[]): string[] =>
  rows.flatMap((row) => (row.kind === "group" ? [row.label] : []));

// --- M3: ordering helper ---

test("orderTasks ranks in_progress, then pending, then completed, failed, cancelled", () => {
  const ordered = orderTasks([
    task("cancelled", "c"),
    task("completed", "done"),
    task("pending", "p"),
    task("failed", "f"),
    task("in_progress", "active"),
  ]);

  assert.deepEqual(
    ordered.map((t) => t.status),
    ["in_progress", "pending", "completed", "failed", "cancelled"],
  );
});

test("orderTasks is stable: same-status tasks keep their original relative order", () => {
  const a = task("pending", "first");
  const b = task("pending", "second");
  const c = task("pending", "third");

  const ordered = orderTasks([a, b, c]);
  assert.deepEqual(
    ordered.map((t) => t.activeForm),
    ["first", "second", "third"],
  );
});

test("orderTasks does not mutate its input", () => {
  const input = [task("completed", "x"), task("in_progress", "y")];
  const before = input.map((t) => t.activeForm);
  orderTasks(input);
  assert.deepEqual(
    input.map((t) => t.activeForm),
    before,
  );
});

// --- M4: five-row cap + overflow ---

test("exactly five tasks render individually with no overflow", () => {
  const display = buildTaskDisplay([
    task("in_progress"),
    task("pending"),
    task("pending"),
    task("completed"),
    task("failed"),
  ]);

  assert.equal(display.rows.length, 5);
  assert.ok(display.rows.every((row) => row.kind === "task"));
  assert.equal(display.hiddenCount, 0);
});

test("six tasks show five rows and a one-task overflow, no grouping", () => {
  const display = buildTaskDisplay([
    task("in_progress"),
    task("pending"),
    task("pending"),
    task("pending"),
    task("completed"),
    task("completed"),
  ]);

  assert.equal(display.rows.length, 5);
  assert.ok(display.rows.every((row) => row.kind === "task"));
  assert.equal(display.hiddenCount, 1);
});

test("ordering is applied before truncation: active and pending win the visible five", () => {
  const display = buildTaskDisplay([
    task("completed", "done-1"),
    task("completed", "done-2"),
    task("in_progress", "active-1"),
    task("pending", "pending-1"),
    task("pending", "pending-2"),
    task("failed", "failed-1"),
  ]);

  // The five visible task rows are the higher-priority ones; a terminal task is the hidden remainder.
  assert.deepEqual(forms(display.rows), ["active-1", "pending-1", "pending-2", "done-1", "done-2"]);
  assert.equal(display.hiddenCount, 1);
});

// --- M4: burst grouping (10-15 fine-grained tasks) ---

test("a burst with one active task groups pending and terminal into broad rows", () => {
  const tasks = [
    task("in_progress", "wiring the API"),
    ...Array.from({ length: 8 }, () => task("pending")),
    ...Array.from({ length: 5 }, () => task("completed")),
    task("failed"),
    task("failed"),
  ];

  const display = buildTaskDisplay(tasks);

  assert.deepEqual(forms(display.rows), ["wiring the API"]);
  assert.deepEqual(labels(display.rows), ["8 upcoming tasks", "5 completed / 2 failed"]);
  assert.equal(display.hiddenCount, 0);
});

test("a burst of only pending tasks coalesces into a single upcoming-count row", () => {
  const display = buildTaskDisplay(Array.from({ length: 12 }, () => task("pending")));

  assert.deepEqual(labels(display.rows), ["12 upcoming tasks"]);
  assert.equal(forms(display.rows).length, 0);
  assert.equal(display.hiddenCount, 0);
});

test("the terminal group names only the non-empty statuses", () => {
  const display = buildTaskDisplay([
    task("in_progress"),
    ...Array.from({ length: 4 }, () => task("pending")),
    task("cancelled"),
    task("cancelled"),
    task("cancelled"),
  ]);

  assert.deepEqual(labels(display.rows), ["4 upcoming tasks", "3 cancelled"]);
});

test("a group that does not fit the cap falls into overflow instead of dropping", () => {
  const display = buildTaskDisplay([
    ...Array.from({ length: 4 }, (_, i) => task("in_progress", `active-${i}`)),
    ...Array.from({ length: 6 }, () => task("pending")),
    ...Array.from({ length: 3 }, () => task("completed")),
  ]);

  // Four active rows fill all but one slot; the pending group takes it, so terminal work is hidden.
  assert.equal(forms(display.rows).length, 4);
  assert.deepEqual(labels(display.rows), ["6 upcoming tasks"]);
  assert.equal(display.hiddenCount, 3);
});

test("an oversized active bucket keeps four rows individual and groups the active overflow", () => {
  const display = buildTaskDisplay([
    ...Array.from({ length: 7 }, (_, i) => task("in_progress", `active-${i}`)),
    task("pending"),
    task("pending"),
  ]);

  assert.equal(forms(display.rows).length, 4);
  assert.deepEqual(labels(display.rows), ["3 active tasks"]);
  // The two pending tasks are represented by no row.
  assert.equal(display.hiddenCount, 2);
});
