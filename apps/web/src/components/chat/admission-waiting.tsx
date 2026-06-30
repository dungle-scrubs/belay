import { Loader2 } from "lucide-react";
import type { AdmissionWaiting } from "@/derive";
import { cn } from "@/lib/utils";

/**
 * The "waiting for the local runtime" status row (plan 11 M7). Shown while the active turn is QUEUED
 * behind another project or subagent for a busy LM Studio resource, with its place in line when known.
 * Bounded LIVE status - it clears the instant admission is granted - so an admission wait never becomes
 * durable transcript content. Renders nothing when there is no wait.
 */
export function AdmissionWaitingRow({
  waiting,
  className,
}: {
  waiting: AdmissionWaiting | null;
  className?: string;
}) {
  if (!waiting) {
    return null;
  }
  // position is 0-based; show a 1-based "#N in line" only when something is ahead.
  const inLine =
    waiting.position !== undefined && waiting.position > 0
      ? ` · #${waiting.position + 1} in line`
      : "";
  const backgroundHint = waiting.priority !== "foreground" ? ` (${waiting.priority})` : "";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Waiting for local model"
      className={cn(
        "flex items-center gap-2 text-xs text-muted-foreground",
        // A subtle pulse marks it as live, not a settled transcript line.
        "animate-pulse",
        className,
      )}
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span className="truncate">
        Waiting for {waiting.model} on the local runtime{backgroundHint}
        {inLine}…
      </span>
    </div>
  );
}
