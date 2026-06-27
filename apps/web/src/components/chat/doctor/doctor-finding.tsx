import { ArrowUpRight, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { DoctorFinding, DoctorNextAction, DoctorStatus } from "@/commands/doctor";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** A finding's message carries its own severity by tint (no leading status dot - that pattern was
 *  too tall): a warning or error message stands out; an ok / not-checked one stays muted. */
function messageTint(status: DoctorStatus): string {
  switch (status) {
    case "warn":
      return "text-smui-yellow";
    case "error":
      return "text-smui-red";
    default:
      return "text-muted-foreground";
  }
}

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
        aria-label={action.label}
        className="flex w-full items-baseline gap-1.5 text-left text-ui text-smui-frost-3 transition-colors hover:text-primary"
      >
        {body}
      </button>
    );
  }

  return <div className="flex items-baseline gap-1.5 text-ui text-smui-frost-3">{body}</div>;
}

/**
 * One finding inside an area: the title and a concise message on a SINGLE line (severity carried by
 * the message tint, not a leading dot - the old dot + two-line layout was too tall), then an optional
 * source path, next action, and an expandable Evidence block for raw internals. Evidence is the only
 * thing that hides; the verdict text is always on screen so a warning or error can never be tucked away.
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
    <div className="flex flex-col gap-0.5 text-ui">
      <p className="break-words">
        <span className="font-medium text-foreground">{finding.title}</span>
        {finding.message ? (
          <span className={cn("ml-2", messageTint(finding.status))}>{finding.message}</span>
        ) : null}
      </p>

      {finding.source ? (
        <code className="block break-all text-label text-muted-foreground/90">
          {finding.source}
        </code>
      ) : null}

      {finding.nextAction ? (
        <DoctorNextActionLine
          action={finding.nextAction}
          onAction={onAction ? () => onAction(finding) : undefined}
        />
      ) : null}

      {finding.evidence ? (
        <Collapsible open={showEvidence} onOpenChange={setShowEvidence}>
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
