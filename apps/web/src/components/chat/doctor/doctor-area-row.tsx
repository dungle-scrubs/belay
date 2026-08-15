import type { DoctorArea, DoctorAreaId, DoctorFinding, DoctorStatus } from "@belay/session";
import {
  Activity,
  ArrowUpCircle,
  BookOpen,
  Bot,
  Braces,
  ChevronDown,
  Cpu,
  FolderGit2,
  Gauge,
  Globe,
  HardDrive,
  Plug,
  Radio,
  Webhook,
  Wrench,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import { cn } from "@/lib/utils";
import { DoctorFindingRow, DoctorNextActionLine } from "./doctor-finding";
import { DOCTOR_STATUS_META, StatusBadge } from "./doctor-status";

/** Each area's glyph - names the domain; severity is carried by the status icon,
 *  the badge, and the left spine. */
const AREA_ICON: Record<DoctorAreaId, ComponentType<{ className?: string }>> = {
  core: Cpu,
  session: Activity,
  providers: Bot,
  internet: Globe,
  tools: Wrench,
  web: BookOpen,
  mcp: Plug,
  lsp: Braces,
  hooks: Webhook,
  storage: HardDrive,
  workspace: FolderGit2,
  admission: Gauge,
  telemetry: Radio,
  updates: ArrowUpCircle,
};

/** A key fact's value tint: the full per-status color when it carries a status (ok reads green),
 *  else plain foreground. The per-status colors live in DOCTOR_STATUS_META. */
function factTint(status: DoctorStatus | undefined): string {
  return status ? DOCTOR_STATUS_META[status].text : "text-foreground";
}

/**
 * One diagnostic area as a single row inside the Doctor panel - not a card. A
 * healthy area is one quiet line: icon, label, verdict, status. Warnings and
 * errors keep that line but show their findings inline beneath it, so a problem
 * is never hidden. Key facts are secondary: the row expands to reveal them, so
 * the resting panel stays scannable instead of dumping every internal.
 *
 * Presentational: the caller supplies the area and an optional action handler.
 */
export function DoctorAreaRow({
  area,
  onAction,
}: {
  area: DoctorArea;
  onAction?: (finding: DoctorFinding) => void;
}) {
  const facts = area.facts ?? [];
  const findings = area.findings ?? [];
  const Icon = AREA_ICON[area.id];
  const [expanded, setExpanded] = useState(false);
  // A warning/error area always shows its findings (a problem can never be collapsed away). A healthy
  // (ok / not-checked) area instead keeps its findings AND facts as collapsible detail, so it rests as
  // one quiet line - the host attaches an informational finding to every area, and without this an
  // all-healthy panel would expand every row into a wall of green.
  const isProblem = area.status === "warn" || area.status === "error";
  const findingsVisible = isProblem || expanded;
  const collapsible = !isProblem && (findings.length > 0 || area.nextAction != null);
  const canExpand = facts.length > 0 || collapsible;

  const header = (
    <>
      <Icon
        className={cn(
          "size-4 shrink-0 translate-y-0.5",
          DOCTOR_STATUS_META[area.status].severityText,
        )}
      />
      <h3 className="shrink-0 text-ui font-medium text-foreground">{area.label}</h3>
      <span className="min-w-0 flex-1 break-words text-ui text-muted-foreground">
        {area.verdict}
      </span>
      <StatusBadge status={area.status} className="shrink-0 self-center" />
      {canExpand ? (
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 self-center text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      ) : null}
    </>
  );

  const showFacts = expanded && facts.length > 0;
  const showFindings = findingsVisible && findings.length > 0;
  const showNextAction = findingsVisible && area.nextAction != null;

  return (
    <div className={cn("flex flex-col", DOCTOR_STATUS_META[area.status].spine)}>
      {/* The whole header row is the hover/click target (full width), not an inset inner box. */}
      {canExpand ? (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-label={`${area.label} area details`}
          className="flex w-full items-baseline gap-2 px-3 py-2.5 text-left transition-colors hover:bg-secondary/40"
        >
          {header}
        </button>
      ) : (
        <div className="flex w-full items-baseline gap-2 px-3 py-2.5">{header}</div>
      )}

      {showFacts || showFindings || showNextAction ? (
        <div className="flex flex-col gap-2 pr-3 pb-2.5 pl-9">
          {/* Facts are secondary - revealed on expand so the resting row stays one line. */}
          {showFacts ? (
            <dl className="flex flex-col gap-1">
              {facts.map((fact) => (
                <div key={fact.label} className="flex items-baseline gap-3 text-ui">
                  <dt className="w-20 shrink-0 text-label tracking-wider text-muted-foreground uppercase">
                    {fact.label}
                  </dt>
                  <dd className={cn("min-w-0 flex-1 break-words", factTint(fact.status))}>
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          {/* A problem's findings are always shown; a healthy area's reveal on expand. */}
          {showFindings ? (
            <div className="flex flex-col gap-2">
              {findings.map((finding) => (
                <DoctorFindingRow key={finding.id} finding={finding} onAction={onAction} />
              ))}
            </div>
          ) : null}

          {showNextAction && area.nextAction ? (
            <DoctorNextActionLine action={area.nextAction} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
