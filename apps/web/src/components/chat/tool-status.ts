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
