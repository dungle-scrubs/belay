import type { TaskSnapshot } from "@belay/session";
import { TreeBranch } from "@/components/tree-branch";
import { cn } from "@/lib/utils";
import {
  buildTaskDisplay,
  type GroupTone,
  type TaskDisplayRow,
  taskRowLabel,
} from "@/tasks-display";

// Task glyphs, matching V1 (tui/src/app/tasks.rs): a FILLED square is the active/running task, an
// EMPTY square is pending, a check marks a done task, a cross marks a failure/cancel. No half-circle.
const TASK_GLYPH: Record<string, string> = {
  pending: "□",
  in_progress: "■",
  completed: "✓",
  failed: "×",
  cancelled: "×",
};

// Per-status styling, matching V1: bold + bright when active (running), dim + strikethrough when
// done, red + bold on failure, muted otherwise.
function rowStyle(status: string): { glyph: string; text: string } {
  switch (status) {
    case "in_progress":
      return { glyph: "text-smui-green", text: "font-bold text-foreground" };
    case "completed":
      return { glyph: "text-smui-green/60", text: "text-muted-foreground/60 line-through" };
    case "failed":
      return { glyph: "text-smui-red", text: "font-bold text-smui-red" };
    case "cancelled":
      return { glyph: "text-muted-foreground/50", text: "text-muted-foreground/60 line-through" };
    default: // pending
      return { glyph: "text-muted-foreground", text: "text-foreground" };
  }
}

// A grouped row borrows a representative status so its glyph reads in the same visual language as the
// rows it stands in for; the label itself stays muted (it is a count summary, not a task).
const GROUP_GLYPH_STATUS: Record<GroupTone, string> = {
  active: "in_progress",
  pending: "pending",
  terminal: "completed",
};

function TaskRow({ task, first }: { task: TaskSnapshot; first: boolean }) {
  const style = rowStyle(task.status);
  return (
    <div className="flex items-baseline gap-1.5">
      <TreeBranch first={first} />
      <span className={cn("select-none", style.glyph)}>{TASK_GLYPH[task.status] ?? "□"}</span>
      <span className={style.text}>
        {taskRowLabel(task)}
        {task.blockedBy.length > 0 ? (
          <span className="text-label text-muted-foreground/60">
            {" "}
            (blocked by {task.blockedBy.join(", ")})
          </span>
        ) : null}
      </span>
    </div>
  );
}

function GroupRow({
  row,
  first,
}: {
  row: Extract<TaskDisplayRow, { kind: "group" }>;
  first: boolean;
}) {
  const glyphStatus = GROUP_GLYPH_STATUS[row.tone];
  return (
    <div className="flex items-baseline gap-1.5">
      <TreeBranch first={first} />
      <span className={cn("select-none", rowStyle(glyphStatus).glyph)}>
        {TASK_GLYPH[glyphStatus] ?? "□"}
      </span>
      <span className="text-muted-foreground">{row.label}</span>
    </div>
  );
}

/**
 * The agent's live checklist, in the header. Renders nothing when the list is empty - so it
 * disappears on its own when the host auto-clears a finished checklist (the snapshot then comes back
 * empty). Presentational only: `buildTaskDisplay` does the ordering, the five-row cap, the burst
 * grouping, and the overflow count (plan 09); the header count always reflects the FULL list, never
 * the visible rows. The tasks nest directly under the header via a single `└` file-tree branch on
 * the first row, and the per-task glyph + styling reads at a glance (filled = active + bold, empty =
 * pending, check = done + strikethrough, cross = failed).
 */
export function TasksPanel({
  tasks,
  stale = false,
}: {
  tasks: readonly TaskSnapshot[];
  /** The checklist is behind the conversation (user spoke after the model last touched it). */
  stale?: boolean;
}) {
  if (tasks.length === 0) {
    return null;
  }

  const done = tasks.filter((t) => t.status === "completed").length;
  const { rows, hiddenCount } = buildTaskDisplay(tasks);

  return (
    <div className="flex flex-col gap-1 py-1 font-mono text-sm">
      <div className="flex items-center gap-2 text-label tracking-wider uppercase text-muted-foreground">
        <span>
          tasks {done}/{tasks.length}
        </span>
        {stale ? (
          <span
            className="text-smui-yellow"
            title="The model hasn't updated this checklist since your last message - it may be out of date."
          >
            stale
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map((row, index) =>
          row.kind === "task" ? (
            <TaskRow key={row.task.id} task={row.task} first={index === 0} />
          ) : (
            <GroupRow key={row.id} row={row} first={index === 0} />
          ),
        )}
        {hiddenCount > 0 ? (
          <div className="flex items-baseline gap-1.5">
            <TreeBranch first={rows.length === 0} />
            <span className="select-none whitespace-pre"> </span>
            <span className="text-muted-foreground/60">...{hiddenCount} more</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
