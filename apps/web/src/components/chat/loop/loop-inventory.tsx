import { Pause, Play, Square, Trash2, Zap } from "lucide-react";
import type { ComponentType } from "react";
import type { LoopControl, LoopInventoryRow, LoopStatus } from "@/commands/loop";
import { loopRunnerLabel } from "@/commands/loop";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Status dot tint + label. Terminal states read muted; live ones carry color. */
const STATUS_STYLE: Record<LoopStatus, { dot: string; label: string }> = {
  completed: { dot: "bg-smui-green", label: "completed" },
  draft: { dot: "bg-smui-frost-3", label: "draft" },
  failed: { dot: "bg-smui-red", label: "failed" },
  paused: { dot: "bg-smui-yellow", label: "paused" },
  running: { dot: "bg-smui-green", label: "running" },
  stopped: { dot: "bg-muted-foreground", label: "stopped" },
};

const CONTROL_META: Record<
  LoopControl,
  { icon: ComponentType<{ className?: string }>; label: string }
> = {
  delete: { icon: Trash2, label: "Delete" },
  pause: { icon: Pause, label: "Pause" },
  resume: { icon: Play, label: "Resume" },
  "run-now": { icon: Zap, label: "Run now" },
  stop: { icon: Square, label: "Stop" },
};

function progressText(row: LoopInventoryRow): string {
  const { completed, max } = row.progress;
  return max === undefined ? `${completed} run` : `${completed}/${max}`;
}

/**
 * The loop inventory: one row per loop with its status, runner, progress, next
 * run, and the lifecycle controls valid in its current state. Presentational -
 * the caller provides the rows and handles each control.
 */
export function LoopInventory(props: {
  rows: readonly LoopInventoryRow[];
  onControl?: (loopId: string, control: LoopControl) => void;
  className?: string;
}) {
  const { rows, onControl, className } = props;

  if (rows.length === 0) {
    return (
      <div
        className={cn(
          "border border-dashed border-border px-3 py-6 text-center text-ui text-muted-foreground",
          className,
        )}
      >
        No loops yet. Type <code className="text-smui-frost-3">/loop</code> to create one.
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {rows.map((row) => {
        const status = STATUS_STYLE[row.status];
        return (
          <div
            key={row.loopId}
            className="flex items-start gap-3 border border-border bg-card px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn("size-2 shrink-0 rounded-full", status.dot)} />
                <span className="text-label tracking-wider text-muted-foreground uppercase">
                  {status.label}
                </span>
                <code className="truncate text-ui text-foreground">{row.summary}</code>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 text-label text-muted-foreground">
                <span>{loopRunnerLabel(row.runner)}</span>
                <span>{progressText(row)}</span>
                {row.nextRun ? <span>{row.nextRun}</span> : null}
                {row.durability === "durable" ? <span>durable</span> : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {row.controls.map((control) => {
                const meta = CONTROL_META[control];
                const Icon = meta.icon;
                return (
                  <Button
                    key={control}
                    variant="ghost"
                    size="icon-xs"
                    title={meta.label}
                    aria-label={`${meta.label} ${row.loopId}`}
                    onClick={() => onControl?.(row.loopId, control)}
                  >
                    <Icon className="size-3.5" />
                  </Button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
