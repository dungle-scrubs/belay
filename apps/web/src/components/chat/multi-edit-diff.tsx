import { createTwoFilesPatch, diffLines } from "diff";
import { ChevronRight } from "lucide-react";
import { DiffViewer } from "@/components/assistant-ui/diff-viewer";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ToolCall } from "./message";

export interface MultiEdit {
  path: string;
  old: string;
  new: string;
}

interface MultiEditDiffProps {
  edits: readonly MultiEdit[];
  status?: "running" | "done" | "error";
  className?: string;
}

function countChanges(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText, newText)) {
    const lines = part.count ?? 0;
    if (part.added) {
      added += lines;
    } else if (part.removed) {
      removed += lines;
    }
  }
  return { added, removed };
}

/**
 * Renders a multi_edit tool call: a single atomic operation made of several edits,
 * grouped by file. Each file is a collapsible section with its own +/- counts; each
 * edit shows up to 3 lines of subdued context.
 */
export function MultiEditDiff({ edits, status = "done", className }: MultiEditDiffProps) {
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

  return (
    <ToolCall name="multi_edit" args={summary} status={status} className={className}>
      <div className="flex flex-col gap-2">
        {groups.map((group) => {
          let added = 0;
          let removed = 0;
          for (const edit of group.edits) {
            const c = countChanges(edit.old, edit.new);
            added += c.added;
            removed += c.removed;
          }
          return (
            <Collapsible
              key={group.path}
              defaultOpen
              className="overflow-hidden border border-border bg-smui-surface-1"
            >
              <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-2 py-1.5">
                <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                <code className="flex-1 truncate text-left text-xs text-foreground">
                  {group.path}
                </code>
                <span className="text-label tracking-wider">
                  <span className="text-smui-green">+{added}</span>{" "}
                  <span className="text-smui-red">-{removed}</span>
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t border-border">
                {group.edits.map((edit) => (
                  <DiffViewer
                    key={`${group.path}::${edit.old}`}
                    patch={createTwoFilesPatch(
                      group.path,
                      group.path,
                      edit.old,
                      edit.new,
                      undefined,
                      undefined,
                      { context: 3 },
                    )}
                    variant="ghost"
                    showHeader={false}
                  />
                ))}
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </ToolCall>
  );
}
