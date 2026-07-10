import { useCreation } from "ahooks";
import type { ReactNode } from "react";
import { DiffViewer } from "@/components/assistant-ui/diff-viewer-lazy";
import { DiffStat, generateToolDiff, type ToolDiff } from "./diff-utils";
import { OpenPathLink } from "./message";
import { StatusAwareToolRenderer } from "./status-aware-tool-renderer";
import { ToolSection } from "./tool-section";
import type { ToolStatus } from "./tool-status";

export interface MultiEdit {
  path: string;
  old: string;
  new: string;
}

/** One file's edits with their diffs prepared and the file's summed +/- counts. */
interface PreparedGroup {
  path: string;
  /** One prepared diff per edit (patch + counts together), in original edit order. */
  prepared: ({ edit: MultiEdit } & ToolDiff)[];
  added: number;
  removed: number;
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
  // Every diff runs diffLines over its edit's texts, so all the diff prep - grouping by
  // file (first-seen order), one prepared diff per edit (patch + counts together, the
  // same single patch-prep path as single edit/write), and the per-file/total +/- sums -
  // is cached on the edits themselves: a parent re-render never re-diffs. The transcript
  // projector keeps an untouched row's `edits` identity stable across streaming deltas.
  const { groups, summary } = useCreation(() => {
    const grouped: PreparedGroup[] = [];
    for (const edit of edits) {
      const prepared = { edit, ...generateToolDiff(edit.path, edit.old, edit.new, 2) };
      const group = grouped.find((g) => g.path === edit.path);
      if (group) {
        group.prepared.push(prepared);
        group.added += prepared.added;
        group.removed += prepared.removed;
      } else {
        grouped.push({
          path: edit.path,
          prepared: [prepared],
          added: prepared.added,
          removed: prepared.removed,
        });
      }
    }

    const totalAdded = grouped.reduce((sum, g) => sum + g.added, 0);
    const totalRemoved = grouped.reduce((sum, g) => sum + g.removed, 0);
    return {
      groups: grouped,
      summary: `${edits.length} edit${edits.length === 1 ? "" : "s"} · ${grouped.length} file${
        grouped.length === 1 ? "" : "s"
      } · +${totalAdded} -${totalRemoved}`,
    };
  }, [edits]);

  // multi_edit boxes per file internally (`border` drives each group), so the outer row never wraps
  // the body in its own ToolSection (border stays false) - the body is the same flat children.
  const body = (
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        const diffs = group.prepared.map((p) => (
          <DiffViewer
            key={`${group.path}::${p.edit.old}`}
            patch={p.patch}
            variant="ghost"
            showHeader={false}
          />
        ));

        if (border) {
          return (
            <ToolSection
              key={group.path}
              title={<code>{fileName(group.path)}</code>}
              meta={<DiffStat added={group.added} removed={group.removed} />}
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
                <DiffStat added={group.added} removed={group.removed} />
              </span>
            </div>
            {diffs}
          </div>
        );
      })}
    </div>
  );

  return (
    <StatusAwareToolRenderer
      name="multi_edit"
      args={summary}
      status={status}
      defaultOpen={defaultOpen}
      className={className}
      renderBody={() => body}
    />
  );
}
