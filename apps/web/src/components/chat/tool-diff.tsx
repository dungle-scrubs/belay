import { createTwoFilesPatch } from "diff";
import { DiffViewer } from "@/components/assistant-ui/diff-viewer";
import { countChanges, DiffStat, withNewline } from "./diff-utils";
import { ToolCall } from "./message";
import { ToolSection } from "./tool-section";

interface ToolDiffProps {
  /** "write" (new/overwritten file) or "edit" (in-place replacement). */
  tool: string;
  path: string;
  /** Prior text for an edit (the old_string); empty for a freshly written file. */
  oldText?: string;
  /** New text: an edit's new_string, or a write's full file content. */
  newText: string;
  status?: "running" | "done" | "error";
  /** Whether the diff body starts expanded; the global compact setting drives this. */
  defaultOpen?: boolean;
  /**
   * Draw the diff inside a bordered ToolSection box with a +/- header. Off by default:
   * a single file's diff sits flat under the already-collapsible tool row, so the box
   * (and its second chevron) would be redundant. multi_edit boxes its files; this is
   * the seam to box a single diff too when wanted.
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
  const patch = createTwoFilesPatch(
    path,
    path,
    withNewline(oldText),
    withNewline(newText),
    undefined,
    undefined,
    { context: 3 },
  );
  const diff = <DiffViewer patch={patch} variant="ghost" showHeader={false} />;
  return (
    <ToolCall
      name={tool}
      args={path}
      status={status}
      defaultOpen={defaultOpen}
      className={className}
      onOpenPath={onOpenPath}
    >
      {border ? (
        <ToolSection meta={<DiffStat {...countChanges(oldText, newText)} />}>{diff}</ToolSection>
      ) : (
        diff
      )}
    </ToolCall>
  );
}
