import type { TaskSnapshot } from "@trevor/richter";
import { useState } from "react";

// Checklist row glyph + color by status (matches the V1 task set).
const TASK_ICON: Record<string, string> = {
  pending: "☐",
  in_progress: "◐",
  completed: "☑",
  failed: "✗",
  cancelled: "⊘",
};
const TASK_COLOR: Record<string, string> = {
  pending: "#555",
  in_progress: "#2a7",
  completed: "#9a9a9a",
  failed: "#c0392b",
  cancelled: "#9a9a9a",
};

/**
 * The agent's live checklist, collapsible, in the header. Renders nothing when the
 * list is empty - so it disappears on its own when the host auto-clears a finished
 * checklist (the snapshot then comes back empty).
 */
export function TasksPanel({ tasks }: { tasks: readonly TaskSnapshot[] }) {
  const [open, setOpen] = useState(true);
  if (tasks.length === 0) {
    return null;
  }
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <div style={{ margin: "0.5rem 0", fontSize: "0.85rem" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          border: "none",
          background: "none",
          padding: 0,
          cursor: "pointer",
          color: "#555",
          fontSize: "0.8rem",
          fontWeight: 600,
        }}
      >
        {open ? "▾" : "▸"} Tasks {done}/{tasks.length}
      </button>
      {open ? (
        <div
          style={{ marginTop: "0.3rem", display: "flex", flexDirection: "column", gap: "0.15rem" }}
        >
          {tasks.map((task) => (
            <div key={task.id} style={{ display: "flex", gap: "0.45rem", alignItems: "baseline" }}>
              <span style={{ color: TASK_COLOR[task.status] ?? "#555" }}>
                {TASK_ICON[task.status] ?? "•"}
              </span>
              <span
                style={{
                  color: task.status === "completed" ? "#9a9a9a" : "#333",
                  textDecoration: task.status === "completed" ? "line-through" : "none",
                }}
              >
                {task.activeForm}
                {task.blockedBy.length > 0 ? (
                  <span style={{ color: "#bbb", fontSize: "0.75rem" }}>
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
