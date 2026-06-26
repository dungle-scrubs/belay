import { LoaderIcon, Split, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { OpenPathLink } from "./message";
import { type ToolStatus, toolStatusColor } from "./tool-status";

/**
 * A burst of read-only tools the host runs concurrently (read/glob/grep/web_search).
 * Because they're side-effect-free, the host fans them out in parallel and they
 * finish out of order - so the unit here is the *batch*, not a single call.
 *
 * Each tool is one tight line. The leading slot is the same size-3 column ToolCall
 * reserves for a row's chevron (collapsible) or spacer (body-less), so the wrench -
 * and everything right of it - lands in the exact same column as every other
 * transcript tool row; the spinner just rides in that gutter to the left of the
 * wrench. While a call runs a spinner sits there; when it settles the spinner clears
 * to a same-width spacer, so the columns hold as rows drop out of "running" in any
 * order. The spinner is the only motion (the wrench doesn't pulse here) and it
 * carries the whole "still working" signal - when every spinner is gone, batch done.
 */
export interface ConcurrentTool {
  /** Stable key; the tool-call id in the live app. */
  id: string;
  name: string;
  args?: ReactNode;
  status: ToolStatus;
  /** When set, the args text opens that file in the local editor (read rows). */
  onOpenPath?: () => void;
}

function ConcurrentToolRow({ name, args, status, onOpenPath }: Omit<ConcurrentTool, "id">) {
  const argsNode = onOpenPath ? (
    <OpenPathLink onOpen={onOpenPath}>{args}</OpenPathLink>
  ) : (
    (args ?? "")
  );

  return (
    <div className="flex items-center gap-2 text-ui text-muted-foreground">
      {/* size-3 = ToolCall's chevron/spacer slot, so the wrench stays column-aligned. */}
      {status === "running" ? (
        <LoaderIcon className="size-3 shrink-0 animate-spin text-smui-yellow" />
      ) : (
        <span className="size-3 shrink-0" aria-hidden />
      )}
      {/* No pulse here: the leading spinner already animates the active rows. */}
      <Wrench className={cn("size-3.5 shrink-0", toolStatusColor(status))} />
      {/* Settled rows dim to muted so the eye tracks what's still in flight. */}
      <code
        className={cn("text-ui", status === "done" ? "text-muted-foreground" : "text-foreground")}
      >
        {name}
        <span className="text-muted-foreground">({argsNode})</span>
      </code>
    </div>
  );
}

export function ConcurrentTools({ tools }: { tools: readonly ConcurrentTool[] }) {
  const running = tools.reduce((count, tool) => count + (tool.status === "running" ? 1 : 0), 0);
  // gap-0.5: rows sit tight so the group reads as one parallel batch, not a stack.
  return (
    <div className="flex flex-col gap-0.5">
      {/* A PERSISTENT "ran in parallel" cue. The per-row spinners only animate while a read is in
          flight, and local reads settle in milliseconds, so without this the concurrency is
          invisible the moment you look - this header stays. While running it counts the in-flight. */}
      <div className="flex items-center gap-1.5 text-label tracking-wider text-smui-frost-3">
        <Split className="size-3 rotate-90" />
        {running > 0
          ? `${running} of ${tools.length} running in parallel`
          : `${tools.length} ran in parallel`}
      </div>
      {tools.map(({ id, ...tool }) => (
        <ConcurrentToolRow key={id} {...tool} />
      ))}
    </div>
  );
}
