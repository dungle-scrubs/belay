import { DiffViewer } from "@/components/assistant-ui/diff-viewer";
import { DiffStat, generateToolDiff } from "./diff-utils";
import { StatusAwareToolRenderer } from "./status-aware-tool-renderer";
import type { ToolStatus } from "./tool-status";

interface ToolDiffProps {
  /** "write" (new/overwritten file) or "edit" (in-place replacement). */
  tool: string;
  path: string;
  /** Prior text for an edit (the old_string); empty for a freshly written file. */
  oldText?: string;
  /** New text: an edit's new_string, or a write's full file content. */
  newText: string;
  status?: ToolStatus;
  /** Whether the diff body starts expanded; the global compact setting drives this. */
  defaultOpen?: boolean;
  /**
   * Draw the diff inside a bordered ToolSection box with a +/- header (see ToolCall's
   * `border`). Off by default: a single file's diff sits flat under the row.
   */
  border?: boolean;
  className?: string;
  /** Opens the edited file in the local editor (the path row becomes clickable). */
  onOpenPath?: () => void;
}

/**
 * Renders a write/edit tool call as a code diff under the ToolCall row, with up to 3
 * lines of subdued, unchanged context. Flat by default (the row already collapses);
 * pass `border` to wrap it in the shared ToolSection box, matching multi_edit's files.
 */
export function ToolDiff({
  tool,
  path,
  oldText = "",
  newText,
  status = "done",
  defaultOpen = true,
  border = false,
  className,
  onOpenPath,
}: ToolDiffProps) {
  const { patch, added, removed } = generateToolDiff(path, oldText, newText, 3);
  const diff = <DiffViewer patch={patch} variant="ghost" showHeader={false} />;
  return (
    <StatusAwareToolRenderer
      name={tool}
      args={path}
      status={status}
      defaultOpen={defaultOpen}
      className={className}
      onOpenPath={onOpenPath}
      border={border}
      sectionMeta={<DiffStat added={added} removed={removed} />}
      renderBody={() => diff}
    />
  );
}
