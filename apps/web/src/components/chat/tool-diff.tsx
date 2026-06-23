import { createTwoFilesPatch } from "diff";
import { DiffViewer } from "@/components/assistant-ui/diff-viewer";
import { ToolCall } from "./message";

interface ToolDiffProps {
  /** "write" (new/overwritten file) or "edit" (in-place replacement). */
  tool: string;
  path: string;
  /** Prior text for an edit (the old_string); empty for a freshly written file. */
  oldText?: string;
  /** New text: an edit's new_string, or a write's full file content. */
  newText: string;
  status?: "running" | "done" | "error";
  className?: string;
}

/**
 * Renders a write/edit tool call as a code diff: the ToolCall row plus a unified
 * diff with up to 3 lines of subdued, unchanged context around each change.
 */
export function ToolDiff({
  tool,
  path,
  oldText = "",
  newText,
  status = "done",
  className,
}: ToolDiffProps) {
  const patch = createTwoFilesPatch(path, path, oldText, newText, undefined, undefined, {
    context: 3,
  });
  return (
    <ToolCall name={tool} args={path} status={status} className={className}>
      <DiffViewer patch={patch} variant="ghost" showHeader={false} />
    </ToolCall>
  );
}
