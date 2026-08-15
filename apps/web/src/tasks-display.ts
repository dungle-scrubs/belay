import type { TaskSnapshot, TaskStatus } from "@belay/session";

/**
 * The compact task-panel display model (plan 09). Pure, React-free helpers that turn the full task
 * snapshot into the prioritized, capped, coalesced view the header panel renders - so the panel stays
 * presentational and the rules (ordering, the five-row cap, burst grouping, overflow) are unit-tested
 * on their own. None of this touches the model-facing checklist, which always renders the full
 * registry (`TaskRegistry.renderForPrompt`); truncation is a UI concern only. <!-- D-001 D-002 D-003 D-008 -->
 */

/** At most this many task/group rows are visible; the rest coalesce into groups and/or an overflow row. */
export const MAX_TASK_ROWS = 5;

/**
 * The text a checklist row renders (plan 50): the task's IMPERATIVE `subject` ("Add tools.json
 * schemas"), so a row reads distinctly from the pinned turn-status header, which owns the tighter
 * present-progressive `activeForm` ("Adding schemas and tests…"). Falls back to `activeForm` only when
 * a task carries no subject (a legacy/partial snapshot), so a row is never blank. The single owner of
 * the row-label field choice, so the panel and any future task surface can't diverge. <!-- D-005 -->
 */
export function taskRowLabel(task: TaskSnapshot): string {
  return task.subject || task.activeForm;
}

/**
 * Just one task over the cap reads better as a literal `...1 more` overflow than as a grouped count, so
 * grouping only engages once the burst is large enough that a status breakdown is more scannable than a
 * row of individual low-priority tasks.
 */
const OVERFLOW_ONLY_MAX = MAX_TASK_ROWS + 1;

/** Display priority: active work first, upcoming next, terminal states last. <!-- D-003 --> */
const STATUS_ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  failed: 3,
  cancelled: 4,
};

function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Orders tasks for display - `in_progress`, then `pending`, then `completed`/`failed`/`cancelled` -
 * keeping the original relative order within each status group (a stable sort). Pure; never mutates
 * the input array. <!-- D-003 -->
 */
export function orderTasks(tasks: readonly TaskSnapshot[]): TaskSnapshot[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => STATUS_ORDER[a.task.status] - STATUS_ORDER[b.task.status] || a.index - b.index)
    .map((entry) => entry.task);
}

/** A group row borrows a status tone so it reads at a glance like the rows it summarizes. */
export type GroupTone = "active" | "pending" | "terminal";

/** One row of the compact panel: an individual task, or a coalesced count of lower-priority work. */
export type TaskDisplayRow =
  | { readonly kind: "task"; readonly task: TaskSnapshot }
  | {
      readonly kind: "group";
      readonly id: string;
      readonly label: string;
      readonly tone: GroupTone;
    };

/** The panel view model: the visible rows, plus how many tasks are represented by no row at all. */
export interface TaskDisplay {
  readonly rows: readonly TaskDisplayRow[];
  /** Tasks represented by no row; the panel renders a trailing `...N more` line when this is > 0. */
  readonly hiddenCount: number;
}

const taskRow = (task: TaskSnapshot): TaskDisplayRow => ({ kind: "task", task });

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const pendingGroup = (count: number): TaskDisplayRow => ({
  kind: "group",
  id: "group-pending",
  tone: "pending",
  label: plural(count, "upcoming task"),
});

const activeGroup = (count: number): TaskDisplayRow => ({
  kind: "group",
  id: "group-active",
  tone: "active",
  label: plural(count, "active task"),
});

/** A terminal-bucket summary like `5 completed / 2 failed`, naming only the non-empty statuses. */
function terminalGroup(terminal: readonly TaskSnapshot[]): TaskDisplayRow {
  const parts = (["completed", "failed", "cancelled"] as const)
    .map((status) => ({ status, count: terminal.filter((task) => task.status === status).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.status}`);

  return { kind: "group", id: "group-terminal", tone: "terminal", label: parts.join(" / ") };
}

/**
 * Builds the compact panel view model from a task snapshot: order by status, cap the visible rows at
 * five, and - for a burst of fine-grained tasks - coalesce the lower-priority buckets into grouped
 * count rows so the panel stays scannable. Active (`in_progress`) tasks stay individual whenever they
 * fit; only when the active bucket alone would consume the whole panel does its overflow collapse into
 * a group. Any task represented by no row is reported in `hiddenCount` for the `...N more` row. Pure
 * and deterministic - no model call, no rewrite of task records. <!-- D-002 D-003 D-008 -->
 */
export function buildTaskDisplay(tasks: readonly TaskSnapshot[]): TaskDisplay {
  const ordered = orderTasks(tasks);

  if (ordered.length <= MAX_TASK_ROWS) {
    return { rows: ordered.map(taskRow), hiddenCount: 0 };
  }

  if (ordered.length <= OVERFLOW_ONLY_MAX) {
    return {
      rows: ordered.slice(0, MAX_TASK_ROWS).map(taskRow),
      hiddenCount: ordered.length - MAX_TASK_ROWS,
    };
  }

  const active = ordered.filter((task) => task.status === "in_progress");
  const pending = ordered.filter((task) => task.status === "pending");
  const terminal = ordered.filter((task) => isTerminal(task.status));

  // The active bucket alone would consume the panel: show the first MAX-1 active rows individually and
  // collapse the rest of active into one group; everything lower priority falls into overflow.
  if (active.length > MAX_TASK_ROWS) {
    const shown = active.slice(0, MAX_TASK_ROWS - 1);
    return {
      rows: [...shown.map(taskRow), activeGroup(active.length - shown.length)],
      hiddenCount: pending.length + terminal.length,
    };
  }

  const rows: TaskDisplayRow[] = active.map(taskRow);
  let hiddenCount = 0;

  const groups: readonly { readonly row: TaskDisplayRow; readonly count: number }[] = [
    ...(pending.length > 0 ? [{ row: pendingGroup(pending.length), count: pending.length }] : []),
    ...(terminal.length > 0 ? [{ row: terminalGroup(terminal), count: terminal.length }] : []),
  ];

  for (const group of groups) {
    if (rows.length < MAX_TASK_ROWS) {
      rows.push(group.row);
    } else {
      hiddenCount += group.count;
    }
  }

  return { rows, hiddenCount };
}
