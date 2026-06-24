import type { TaskSnapshot } from "@trevor/session";
import { useBoolean } from "ahooks";
import { cn } from "@/lib/utils";

// Checklist row glyph + SMUI color by status (matches the V1 task set).
const TASK_ICON: Record<string, string> = {
  pending: "☐",
  in_progress: "◐",
  completed: "☑",
  failed: "✗",
  cancelled: "⊘",
};
const TASK_COLOR: Record<string, string> = {
  pending: "text-muted-foreground",
  in_progress: "text-smui-green",
  completed: "text-muted-foreground/70",
  failed: "text-smui-red",
  cancelled: "text-muted-foreground/70",
};

/**
 * The agent's live checklist, collapsible, in the header. Renders nothing when the
 * list is empty - so it disappears on its own when the host auto-clears a finished
 * checklist (the snapshot then comes back empty).
 */
export function TasksPanel({ tasks }: { tasks: readonly TaskSnapshot[] }) {
  const [open, { toggle }] = useBoolean(true);
  if (tasks.length === 0) {
    return null;
  }
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <button
        type="button"
        onClick={toggle}
        className="flex w-fit cursor-pointer items-center gap-1 text-label tracking-wider uppercase text-muted-foreground hover:text-foreground"
      >
        {open ? "▾" : "▸"} tasks {done}/{tasks.length}
      </button>
      {open ? (
        <div className="flex flex-col gap-0.5">
          {tasks.map((task) => (
            <div key={task.id} className="flex items-baseline gap-1.5">
              <span className={TASK_COLOR[task.status] ?? "text-muted-foreground"}>
                {TASK_ICON[task.status] ?? "•"}
              </span>
              <span
                className={cn(
                  task.status === "completed" && "text-muted-foreground/70 line-through",
                )}
              >
                {task.activeForm}
                {task.blockedBy.length > 0 ? (
                  <span className="text-label text-muted-foreground/60">
                    {" "}
                    (blocked by {task.blockedBy.join(", ")})
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
