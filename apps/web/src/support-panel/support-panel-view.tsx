import type { TaskSnapshot } from "@belay/session";
import { Maximize2, Trash2, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { TasksPanel } from "@/tasks-panel";
import {
  buildSupportPanel,
  type PanelJob,
  type SupportBackgroundRow,
  type SupportSubagent,
  type SupportTone,
} from "./support-panel";

/**
 * The thread support panel (plan 09 M6): the V1-inspired bottom support area that REPLACES the task-only
 * panel. It shows the task checklist (reusing {@link TasksPanel}) and a background group (subagents above
 * jobs). It is responsive via a `@container` query: when BOTH sections exist AND the container is wide
 * enough it lays out two columns (tasks left, background right); otherwise it stacks one column. A job
 * row is detail-eligible (opens the tool-detail takeover) and carries a kill control while running;
 * background overflow past a cap discloses with a "…N more" toggle. Rows keep a stable height and avoid
 * nested card chrome.
 */

const BACKGROUND_CAP = 5;

const TONE_GLYPH: Record<SupportTone, string> = {
  running: "text-smui-yellow",
  done: "text-smui-frost-3",
  error: "text-smui-red",
};

export function SupportPanel({
  tasks,
  subagents,
  jobs,
  stale = false,
  onOpenJobDetail,
  onKillJob,
  onDismissJob,
  className,
}: {
  readonly tasks: readonly TaskSnapshot[];
  readonly subagents: readonly SupportSubagent[];
  readonly jobs: readonly PanelJob[];
  readonly stale?: boolean;
  readonly onOpenJobDetail?: (jobId: string) => void;
  readonly onKillJob?: (jobId: string) => void;
  readonly onDismissJob?: (jobId: string) => void;
  readonly className?: string;
}) {
  const panel = buildSupportPanel({ tasks, subagents, jobs });
  if (!panel.hasTasks && !panel.hasBackground) {
    return null;
  }
  return (
    <div className={cn("@container", className)}>
      <div className={cn("flex flex-col gap-3", panel.twoColumn && "@md:flex-row @md:gap-6")}>
        {panel.hasTasks ? (
          <div className="min-w-0 @md:flex-1">
            <TasksPanel tasks={tasks} stale={stale} />
          </div>
        ) : null}
        {panel.hasBackground ? (
          <BackgroundGroup
            rows={panel.background}
            onOpenJobDetail={onOpenJobDetail}
            onKillJob={onKillJob}
            onDismissJob={onDismissJob}
          />
        ) : null}
      </div>
    </div>
  );
}

function BackgroundGroup({
  rows,
  onOpenJobDetail,
  onKillJob,
  onDismissJob,
}: {
  readonly rows: readonly SupportBackgroundRow[];
  readonly onOpenJobDetail?: (jobId: string) => void;
  readonly onKillJob?: (jobId: string) => void;
  readonly onDismissJob?: (jobId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = expanded ? 0 : Math.max(0, rows.length - BACKGROUND_CAP);
  const visible = expanded ? rows : rows.slice(0, BACKGROUND_CAP);
  return (
    <div className="flex min-w-0 flex-col gap-1 py-1 font-mono text-sm @md:flex-1">
      <div className="text-label tracking-wider uppercase text-muted-foreground">
        background {rows.length}
      </div>
      <ul className="flex flex-col gap-0.5">
        {visible.map((row) => (
          <BackgroundRow
            key={row.id}
            row={row}
            onOpenJobDetail={onOpenJobDetail}
            onKillJob={onKillJob}
            onDismissJob={onDismissJob}
          />
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start rounded px-1 text-label text-muted-foreground/60 hover:text-foreground"
        >
          …{hidden} more
        </button>
      ) : null}
    </div>
  );
}

function BackgroundRow({
  row,
  onOpenJobDetail,
  onKillJob,
  onDismissJob,
}: {
  readonly row: SupportBackgroundRow;
  readonly onOpenJobDetail?: (jobId: string) => void;
  readonly onKillJob?: (jobId: string) => void;
  readonly onDismissJob?: (jobId: string) => void;
}) {
  const running = row.tone === "running";
  return (
    <li className="group/row flex h-6 items-center gap-1.5">
      <span className={cn("select-none", TONE_GLYPH[row.tone])}>
        {row.kind === "subagent" ? "◆" : "●"}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground">{row.label}</span>
      <span className="shrink-0 text-label text-muted-foreground/60">{row.statusLabel}</span>
      {row.detailEligible && onOpenJobDetail ? (
        <button
          type="button"
          onClick={() => onOpenJobDetail(row.id)}
          aria-label={`Inspect ${row.id}`}
          title="Inspect"
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <Maximize2 className="size-3" />
        </button>
      ) : null}
      {row.kind === "job" && running && onKillJob ? (
        <button
          type="button"
          onClick={() => onKillJob(row.id)}
          aria-label={`Stop ${row.id}`}
          title="Stop"
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-smui-red focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <X className="size-3" />
        </button>
      ) : null}
      {row.kind === "job" && row.dismissEligible && onDismissJob ? (
        <button
          type="button"
          onClick={() => onDismissJob(row.id)}
          aria-label={`Dismiss ${row.id}`}
          title="Dismiss"
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <Trash2 className="size-3" />
        </button>
      ) : null}
    </li>
  );
}
