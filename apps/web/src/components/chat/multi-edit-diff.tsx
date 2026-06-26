import { createTwoFilesPatch } from "diff";
import type { ReactNode } from "react";
import { DiffViewer } from "@/components/assistant-ui/diff-viewer";
import { countChanges, DiffStat, withNewline } from "./diff-utils";
import { OpenPathLink, ToolCall } from "./message";
import { ToolSection } from "./tool-section";
import type { ToolStatus } from "./tool-status";

export interface MultiEdit {
  path: string;
  old: string;
  new: string;
}

interface MultiEditDiffProps {
  edits: readonly MultiEdit[];
  status?: ToolStatus;
  /** Whether the whole operation starts expanded; the global compact setting drives this. */
  defaultOpen?: boolean;
  /**
   * Wrap each file in a bordered ToolSection box. On by default: multi_edit spans files,
   * so per-file boxes give each its own border, name, and collapse. Off renders each file
   * as a flat name + stat header over its diffs (no box), to match single edit/write.
   */
  border?: boolean;
  className?: string;
  /** Opens a file in the local editor (each file name becomes a clickable link). */
  onOpenPath?: (path: string) => void;
}

/**
 * Renders a multi_edit tool call: a single atomic operation made of several edits,
 * grouped by file. Each file shows its own +/- counts; each edit shows up to 2 lines of
 * subdued surrounding context. Files are bordered ToolSection boxes by default (`border`).
 */
export function MultiEditDiff({
  edits,
  status = "done",
  defaultOpen = true,
  border = true,
  className,
  onOpenPath,
}: MultiEditDiffProps) {
  // A file name: a click-to-open link when `onOpenPath` is wired, else plain text.
  const fileName = (path: string): ReactNode =>
    onOpenPath ? <OpenPathLink onOpen={() => onOpenPath(path)}>{path}</OpenPathLink> : path;
  // Group by file, preserving first-seen order.
  const groups: { path: string; edits: MultiEdit[] }[] = [];
  for (const edit of edits) {
    const group = groups.find((g) => g.path === edit.path);
    if (group) {
      group.edits.push(edit);
    } else {
      groups.push({ path: edit.path, edits: [edit] });
    }
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  for (const edit of edits) {
    const { added, removed } = countChanges(edit.old, edit.new);
    totalAdded += added;
    totalRemoved += removed;
  }

  const summary = `${edits.length} edit${edits.length === 1 ? "" : "s"} · ${groups.length} file${
    groups.length === 1 ? "" : "s"
  } · +${totalAdded} -${totalRemoved}`;

  // multi_edit boxes per file internally (`border` drives each group), so the outer row never wraps
  // the body in its own ToolSection (border stays false) - the body is the same flat children.
  const body = (
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        let added = 0;
        let removed = 0;
        for (const edit of group.edits) {
          const c = countChanges(edit.old, edit.new);
          added += c.added;
          removed += c.removed;
        }
        const diffs = group.edits.map((edit) => (
          <DiffViewer
            key={`${group.path}::${edit.old}`}
            patch={createTwoFilesPatch(
              group.path,
              group.path,
              withNewline(edit.old),
              withNewline(edit.new),
              undefined,
              undefined,
              { context: 2 },
            )}
            variant="ghost"
            showHeader={false}
          />
        ));

        if (border) {
          return (
            <ToolSection
              key={group.path}
              title={<code>{fileName(group.path)}</code>}
              meta={<DiffStat added={added} removed={removed} />}
            >
              {diffs}
            </ToolSection>
          );
        }

        return (
          <div key={group.path} className="flex flex-col">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <code className="flex-1 truncate text-xs text-foreground">
                {fileName(group.path)}
              </code>
              <span className="shrink-0 text-label tracking-wider">
                <DiffStat added={added} removed={removed} />
              </span>
            </div>
            {diffs}
          </div>
        );
      })}
    </div>
  );

  return (
    <ToolCall
      name="multi_edit"
      args={summary}
      status={status}
      defaultOpen={defaultOpen}
      className={className}
    >
      {body}
    </ToolCall>
  );
}
