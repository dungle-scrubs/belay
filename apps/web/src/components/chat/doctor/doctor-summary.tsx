import { Braces, Clock, Copy, ListFilter, Loader, RefreshCw } from "lucide-react";
import type { DoctorSnapshotState, DoctorStatus, DoctorSummary } from "@/commands/doctor";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { DOCTOR_STATUS_META, StatusDot, StatusIcon } from "./doctor-status";

/** Headline for the overall snapshot status. */
const OVERALL_HEADLINE: Record<DoctorStatus, string> = {
  ok: "Healthy",
  warn: "Degraded",
  error: "Problems found",
  not_checked: "Not checked",
};

/** A label per count bucket, most-severe first. `error`/`warning` take a plural
 *  for any count but 1; `ok` / `not checked` don't inflect. */
const COUNT_ORDER: readonly {
  status: DoctorStatus;
  key: keyof DoctorSummary;
  label: (count: number) => string;
}[] = [
  { status: "error", key: "error", label: (n) => (n === 1 ? "error" : "errors") },
  { status: "warn", key: "warn", label: (n) => (n === 1 ? "warning" : "warnings") },
  { status: "ok", key: "ok", label: () => "ok" },
  { status: "not_checked", key: "notChecked", label: () => "not checked" },
];

function CountChip({
  status,
  count,
  label,
}: {
  status: DoctorStatus;
  count: number;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ui">
      <StatusDot status={status} />
      <span className="font-medium text-foreground tabular-nums">{count}</span>
      <span className="text-label tracking-wider text-muted-foreground uppercase">{label}</span>
    </span>
  );
}

/** Freshness / probe state, right of the counts. Refreshing spins; stale warns. */
function Freshness({ state, checkedAt }: { state: DoctorSnapshotState; checkedAt?: string }) {
  if (state === "refreshing") {
    return (
      <span className="inline-flex items-center gap-1.5 text-ui text-smui-yellow">
        <Loader className="size-3.5 animate-spin" />
        Refreshing…
      </span>
    );
  }
  if (state === "stale") {
    return (
      <span className="inline-flex items-center gap-1.5 text-ui text-smui-yellow">
        <Clock className="size-3.5" />
        {checkedAt ?? "stale snapshot"} · stale
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-ui text-muted-foreground">
      <Clock className="size-3.5" />
      {checkedAt ?? "checked"}
    </span>
  );
}

/** Optional callbacks for the inspection affordances. All no-ops if unset. */
export interface DoctorSummaryActions {
  readonly onRefresh?: () => void;
  readonly onCopyReport?: () => void;
  readonly onViewJson?: () => void;
}

/**
 * The top summary strip: overall status and headline, the four always-visible
 * count buckets (errors and warnings can never be hidden here), the freshness /
 * refresh state, the "issues only" toggle, and the refresh / copy / JSON
 * affordances. Stacks on a narrow card, spreads into one row when there's room.
 *
 * Presentational: the parent owns `issuesOnly` and passes the action handlers.
 */
export function DoctorSummaryStrip({
  status,
  summary,
  state,
  checkedAt,
  issuesOnly,
  onIssuesOnlyChange,
  actions,
}: {
  status: DoctorStatus;
  summary: DoctorSummary;
  state: DoctorSnapshotState;
  checkedAt?: string;
  issuesOnly: boolean;
  onIssuesOnlyChange: (next: boolean) => void;
  actions?: DoctorSummaryActions;
}) {
  const headlineTint = DOCTOR_STATUS_META[status].text;
  const issueCount = summary.error + summary.warn;

  return (
    <div className="@container/summary flex flex-col gap-3 border-b border-border p-3 @2xl/summary:flex-row @2xl/summary:items-center @2xl/summary:justify-between">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <StatusIcon status={status} className="size-5" />
          <div className="leading-tight">
            <div className={cn("text-ui font-medium", headlineTint)}>
              {OVERALL_HEADLINE[status]}
            </div>
            <div className="text-label tracking-wider text-muted-foreground uppercase">
              {summary.total} areas
            </div>
          </div>
        </div>

        <Separator orientation="vertical" className="hidden h-8 @xs/summary:block" />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {COUNT_ORDER.map(({ status: countStatus, key, label }) => {
            const count = summary[key] as number;
            return <CountChip key={key} status={countStatus} count={count} label={label(count)} />;
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Freshness state={state} checkedAt={checkedAt} />

        <Button
          variant={issuesOnly ? "secondary" : "outline"}
          size="xs"
          onClick={() => onIssuesOnlyChange(!issuesOnly)}
          aria-pressed={issuesOnly}
          title="Show only areas with warnings or errors"
        >
          <ListFilter className="size-3" />
          Issues only
          {issueCount > 0 ? (
            <span className="tabular-nums text-muted-foreground">({issueCount})</span>
          ) : null}
        </Button>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-xs"
            onClick={actions?.onRefresh}
            disabled={state === "refreshing"}
            title="Refresh diagnostics"
            aria-label="Refresh diagnostics"
          >
            <RefreshCw className={cn("size-3", state === "refreshing" && "animate-spin")} />
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            onClick={actions?.onCopyReport}
            title="Copy report"
            aria-label="Copy report"
          >
            <Copy className="size-3" />
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            onClick={actions?.onViewJson}
            title="View JSON"
            aria-label="View JSON"
          >
            <Braces className="size-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
