import type { ToolCallMessagePartStatus } from "@assistant-ui/react";
import { AlertCircleIcon, CheckIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import type { ElementType } from "react";
import { cn } from "@/lib/utils";

/**
 * The single status→presentation config for tool rows (D-014). One wrench color per lifecycle state,
 * shared by the transcript `ToolCall` row and the concurrent-batch rows so the two can never drift.
 * The base color is identical everywhere; only WHETHER `running` pulses differs - the transcript row
 * pulses its wrench, while a concurrent batch leaves it still because the leading spinner already
 * carries the motion. That one difference is the `pulse` flag, not a second color map.
 */

/** The lifecycle of a tool call as the chat renders it: the single union every tool renderer shares. */
export type ToolStatus = "running" | "done" | "error";

/** True when a completed tool result is the `error:` failure convention (what tool-message parses). */
export function isErrorResult(result: string | undefined): boolean {
  return result?.startsWith("error:") ?? false;
}

/**
 * The single rule mapping a tool message to its lifecycle status: an aborted run is an error (never a
 * stuck spinner), an unfinished call is running, and a finished call is `error` when its result is the
 * `error:` convention else `done`. Both the transcript row and the concurrent batch derive from this,
 * so a done-with-error-result tool can't read "done" in one and "error" in the other.
 */
export function toolMessageStatus(tool: {
  readonly aborted?: boolean;
  readonly done?: boolean;
  readonly result?: string;
}): ToolStatus {
  if (tool.aborted) {
    return "error";
  }
  if (!tool.done) {
    return "running";
  }
  return isErrorResult(tool.result) ? "error" : "done";
}

/** The shell lane's lifecycle rule, shared by compact rows and the detail takeover. */
export function shellMessageStatus(shell: {
  readonly done: boolean;
  readonly ok?: boolean;
}): ToolStatus {
  if (!shell.done) {
    return "running";
  }
  return shell.ok === false ? "error" : "done";
}

/** Status shows in the wrench icon color (no separate dot). */
const TOOL_STATUS_COLOR: Record<ToolStatus, string> = {
  running: "text-smui-yellow",
  done: "text-smui-frost-3",
  error: "text-smui-red",
};

/** The wrench className for a status; `pulse` adds the running animation (the transcript row only). */
export function toolStatusColor(status: ToolStatus, pulse = false): string {
  return cn(TOOL_STATUS_COLOR[status], pulse && status === "running" && "animate-pulse");
}

/**
 * The assistant-ui tool-call lifecycle (running / complete / incomplete / requires-action) - a
 * different axis from the transcript `ToolStatus` above (this one carries the kit's approval and
 * cancellation states), so it has its own icon map. Keyed on the part status `type` the kit reports.
 */
type ToolPartStatus = ToolCallMessagePartStatus["type"];

/** The single status -> lifecycle-icon map, shared by every surface that shows a tool-call status icon. */
const TOOL_STATUS_ICON: Record<ToolPartStatus, ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

/** The lifecycle icon component for an assistant-ui tool-call status (M29; was tool-fallback's local map). */
export function statusIcon(status: ToolPartStatus): ElementType {
  return TOOL_STATUS_ICON[status];
}
