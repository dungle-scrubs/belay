import { ArrowUpRight, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { DoctorFinding, DoctorNextAction } from "@/commands/doctor";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { StatusDot } from "./doctor-status";

/** The next-action affordance: a label, plus the exact command/path monospace
 *  when one is known. A button when the caller wires `onAction`, otherwise a
 *  static line - either way the text wraps rather than overflowing the card.
 *  Shared by finding rows and the area-level action. */
export function DoctorNextActionLine({
  action,
  onAction,
}: {
  action: DoctorNextAction;
  onAction?: () => void;
}) {
  const body = (
    <>
      <ArrowUpRight className="size-3.5 shrink-0 translate-y-px" />
      <span className="min-w-0">
        <span className="font-medium">{action.label}</span>
        {action.command ? (
          <code className="ml-1.5 break-all text-muted-foreground">{action.command}</code>
        ) : null}
      </span>
    </>
  );

  if (onAction) {
    return (
      <button
        type="button"
        onClick={onAction}
        className="flex w-full items-baseline gap-1.5 text-left text-ui text-smui-frost-3 transition-colors hover:text-primary"
      >
        {body}
      </button>
    );
  }

  return <div className="flex items-baseline gap-1.5 text-ui text-smui-frost-3">{body}</div>;
}

/**
 * One finding inside an area card: a status dot, the title, and a concise
 * message - all always visible, never collapsed - then an optional source path,
 * next action, and an expandable Evidence block for raw internals. Evidence is
 * the only thing that hides; the verdict itself is always on screen so a warning
 * or error can never be tucked away.
 *
 * Presentational: the caller supplies the finding and an optional action handler.
 */
export function DoctorFindingRow({
  finding,
  onAction,
}: {
  finding: DoctorFinding;
  onAction?: (finding: DoctorFinding) => void;
}) {
  const [showEvidence, setShowEvidence] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <StatusDot status={finding.status} className="translate-y-1" />
        <span className="min-w-0 flex-1 break-words text-ui font-medium text-foreground">
          {finding.title}
        </span>
      </div>

      {/* pl-4 aligns the body under the title, clear of the size-2 dot + gap. */}
      <p className="break-words pl-4 text-ui text-muted-foreground">{finding.message}</p>

      {finding.source ? (
        <code className="block break-all pl-4 text-label text-muted-foreground/90">
          {finding.source}
        </code>
      ) : null}

      {finding.nextAction ? (
        <div className="pl-4">
          <DoctorNextActionLine
            action={finding.nextAction}
            onAction={onAction ? () => onAction(finding) : undefined}
          />
        </div>
      ) : null}

      {finding.evidence ? (
        <Collapsible open={showEvidence} onOpenChange={setShowEvidence} className="pl-4">
          <CollapsibleTrigger className="flex items-center gap-1 text-label tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground">
            <ChevronRight
              className={cn("size-3 transition-transform", showEvidence && "rotate-90")}
            />
            {showEvidence ? "Hide evidence" : "Evidence"}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words border border-border bg-smui-surface-2/50 p-2 text-label text-muted-foreground">
              {finding.evidence}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
