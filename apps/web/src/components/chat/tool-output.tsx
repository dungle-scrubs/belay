import type { ReactNode } from "react";
import { ToolCall } from "./message";
import { ToolSection } from "./tool-section";

// Default number of output lines to show before hiding the rest behind a "+N more"
// indicator. A long listing (e.g. `find` over a tree) otherwise floods the transcript;
// a few lines is enough to read the shape of the output. Per-call overridable via the
// `previewLines` prop, so a global setting can drive it later.
const PREVIEW_LINES = 3;

interface ToolOutputProps {
  name: string;
  args?: ReactNode;
  /** The tool's text output (command output, grep matches, ...); a bare row when absent. */
  output?: string;
  status?: "running" | "done" | "error";
  /** Whether the output body starts expanded; the global compact setting drives this. */
  defaultOpen?: boolean;
  /**
   * Draw the output inside a bordered ToolSection box. Off by default: a single output
   * block sits flat under the already-collapsible tool row, matching edit/write/web_search.
   */
  border?: boolean;
  /** Lines of output to show before the rest is hidden behind a "+N more" indicator. */
  previewLines?: number;
  className?: string;
}

/**
 * Renders a text-output tool call (bash, grep, ...) as the ToolCall row over its raw
 * output - the generic counterpart to the diff and web_search renderers, sharing the
 * same `border` (flat vs ToolSection box) and `defaultOpen` seams. With no output yet
 * (still running, or a tool that returns nothing) it renders the bare row.
 */
export function ToolOutput({
  name,
  args,
  output,
  status = "done",
  defaultOpen = true,
  border = false,
  previewLines = PREVIEW_LINES,
  className,
}: ToolOutputProps) {
  if (!output) {
    return (
      <ToolCall
        name={name}
        args={args}
        status={status}
        defaultOpen={defaultOpen}
        className={className}
      />
    );
  }

  const body = <OutputBody output={output} previewLines={previewLines} />;
  return (
    <ToolCall
      name={name}
      args={args}
      status={status}
      defaultOpen={defaultOpen}
      className={className}
    >
      {border ? <ToolSection>{<div className="p-2.5">{body}</div>}</ToolSection> : body}
    </ToolCall>
  );
}

/**
 * The raw text body of a tool output: subdued, monospaced, and capped at a few lines.
 * Output past `previewLines` is hidden behind an ellipsis and a "+N more lines"
 * indicator, so a big listing doesn't flood the transcript. Seeing the full output in
 * detail is a separate control (added later); this is just the at-a-glance preview.
 */
function OutputBody({ output, previewLines }: { output: string; previewLines: number }) {
  // Drop trailing blank lines so a final newline doesn't count as hidden output.
  const lines = output.replace(/\n+$/, "").split("\n");
  const hidden = lines.length - previewLines;
  const shown = (hidden > 0 ? lines.slice(0, previewLines) : lines).join("\n");

  return (
    <div className="flex flex-col gap-0.5">
      <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
        {shown}
      </pre>
      {hidden > 0 ? (
        <span className="text-label tracking-wider text-muted-foreground/60">
          … +{hidden} more {hidden === 1 ? "line" : "lines"}
        </span>
      ) : null}
    </div>
  );
}
