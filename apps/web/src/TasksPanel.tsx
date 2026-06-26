import type { TaskSnapshot } from "@trevor/session";
import { cn } from "@/lib/utils";

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

/**
 * The agent's live checklist, in the header. Renders nothing when the list is empty - so it
 * disappears on its own when the host auto-clears a finished checklist (the snapshot then comes back
 * empty). Not collapsible: the tasks nest directly under the header via a single `└` file-tree branch
 * on the first row (the rest align beneath it), and the per-task glyph + styling reads at a glance
 * (filled = active + bold, empty = pending, check = done + strikethrough, cross = failed).
 */
export function TasksPanel({ tasks }: { tasks: readonly TaskSnapshot[] }) {
  if (tasks.length === 0) {
    return null;
  }
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <div className="flex flex-col gap-1 font-mono text-sm">
      <div className="text-label tracking-wider uppercase text-muted-foreground">
        tasks {done}/{tasks.length}
      </div>
      <div className="flex flex-col gap-0.5">
        {tasks.map((task, index) => {
          const style = rowStyle(task.status);
          return (
            <div key={task.id} className="flex items-baseline gap-1.5">
              {/* A single nested-file branch: the first task carries the `└`, the rest align under it,
                so the whole list reads as nested below the TASKS header. */}
              <span className="select-none whitespace-pre text-muted-foreground/40">
                {index === 0 ? "└" : " "}
              </span>
              <span className={cn("select-none", style.glyph)}>
                {TASK_GLYPH[task.status] ?? "□"}
              </span>
              <span className={style.text}>
                {task.activeForm}
                {task.blockedBy.length > 0 ? (
                  <span className="text-label text-muted-foreground/60">
                    {" "}
                    (blocked by {task.blockedBy.join(", ")})
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
