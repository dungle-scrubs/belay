import { CircleCheck } from "lucide-react";
import { useState } from "react";
import {
  type DoctorFinding,
  type DoctorSnapshot,
  isIssue,
  overallStatus,
  summarizeSnapshot,
} from "@/commands/doctor";
import { cn } from "@/lib/utils";
import { DoctorAreaRow } from "./doctor-area-row";
import { type DoctorSummaryActions, DoctorSummaryStrip } from "./doctor-summary";

/**
 * The `/doctor` health surface: one panel, not a grid of cards. A quiet summary
 * header band sits above a single divided list of area rows. Healthy areas read
 * as one calm line each; warnings and errors expand inline with their findings
 * and next actions, so the panel says what's broken, why, and what to do without
 * a wall of boxes.
 *
 * "Issues only" filters to warn/error areas; that is the only filter and it
 * keeps exactly the problem areas, so a warning or error can never be hidden.
 * Presentational: the host supplies the snapshot; actions are optional.
 */
export function DoctorPanel({
  snapshot,
  actions,
  onAction,
  className,
}: {
  snapshot: DoctorSnapshot;
  actions?: DoctorSummaryActions;
  onAction?: (finding: DoctorFinding) => void;
  className?: string;
}) {
  const [issuesOnly, setIssuesOnly] = useState(false);

  // Initial probe with nothing to show yet: a skeleton, not an empty panel.
  if (snapshot.state === "refreshing" && snapshot.areas.length === 0) {
    return <DoctorPanelSkeleton className={className} />;
  }

  const summary = summarizeSnapshot(snapshot);
  const status = overallStatus(snapshot);
  const hasIssues = summary.error + summary.warn > 0;
  const areas = issuesOnly ? snapshot.areas.filter(isIssue) : snapshot.areas;

  return (
    <div className={cn("@container border border-border bg-card", className)}>
      <DoctorSummaryStrip
        status={status}
        summary={summary}
        state={snapshot.state}
        checkedAt={snapshot.checkedAt}
        issuesOnly={issuesOnly}
        onIssuesOnlyChange={setIssuesOnly}
        actions={actions}
      />

      {issuesOnly && !hasIssues ? (
        <AllClear total={summary.total} />
      ) : (
        <div className="divide-y divide-border">
          {areas.map((area) => (
            <DoctorAreaRow key={area.id} area={area} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Shown when "issues only" is on and nothing is wrong - the healthy resting state. */
function AllClear({ total }: { total: number }) {
  return (
    <div className="flex flex-col items-center gap-1 px-3 py-10 text-center">
      <CircleCheck className="size-6 text-smui-green" />
      <p className="text-ui font-medium text-foreground">No warnings or errors</p>
      <p className="text-sm text-muted-foreground">All {total} areas are healthy.</p>
    </div>
  );
}

/** A placeholder while the host runs its first probe. Mirrors the panel chrome so
 *  the layout doesn't jump when the snapshot arrives. */
export function DoctorPanelSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("border border-border bg-card", className)}>
      <div className="border-b border-border p-3">
        <div className="h-8 w-full skeleton" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: 6 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static placeholder
          <div key={index} className="px-3 py-2.5">
            <div className="h-5 w-full skeleton" />
          </div>
        ))}
      </div>
    </div>
  );
}
