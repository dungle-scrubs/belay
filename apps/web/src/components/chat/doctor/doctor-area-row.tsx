import {
  Activity,
  ArrowUpCircle,
  BookOpen,
  Bot,
  Braces,
  ChevronDown,
  Cpu,
  FolderGit2,
  Globe,
  HardDrive,
  Plug,
  Webhook,
  Wrench,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import type { DoctorArea, DoctorAreaId, DoctorFinding, DoctorStatus } from "@/commands/doctor";
import { cn } from "@/lib/utils";
import { DoctorFindingRow, DoctorNextActionLine } from "./doctor-finding";
import { StatusBadge } from "./doctor-status";

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
  updates: ArrowUpCircle,
};

/** A left spine in the status color makes a problem row scannable down the panel
 *  without boxing every area; ok / not-checked rows stay flush. */
function spine(status: DoctorStatus): string {
  switch (status) {
    case "error":
      return "border-l-2 border-l-smui-red";
    case "warn":
      return "border-l-2 border-l-smui-yellow";
    default:
      return "border-l-2 border-l-transparent";
  }
}

/** The single leading icon carries both domain (its glyph) and severity (its
 *  tint): warn/error stand out, ok/not-checked stay muted. Status is repeated
 *  only on the right badge - not as a third left icon. */
function iconTint(status: DoctorStatus): string {
  switch (status) {
    case "error":
      return "text-smui-red";
    case "warn":
      return "text-smui-yellow";
    default:
      return "text-muted-foreground";
  }
}

function factTint(status: DoctorStatus | undefined): string {
  switch (status) {
    case "ok":
      return "text-smui-green";
    case "warn":
      return "text-smui-yellow";
    case "error":
      return "text-smui-red";
    case "not_checked":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
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
  const canExpand = facts.length > 0;

  const header = (
    <div className="flex w-full items-baseline gap-2 text-left">
      <Icon className={cn("size-4 shrink-0 translate-y-0.5", iconTint(area.status))} />
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
    </div>
  );

  return (
    <div className={cn("flex flex-col gap-2 px-3 py-2.5", spine(area.status))}>
      {canExpand ? (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-label={`${area.label} area details`}
          className="-mx-1 rounded-sm px-1 transition-colors hover:bg-secondary/40"
        >
          {header}
        </button>
      ) : (
        header
      )}

      {/* Facts are secondary - revealed on expand so the resting row stays one line. */}
      {expanded && facts.length > 0 ? (
        <dl className="flex flex-col gap-1 pl-6">
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

      {/* Findings are always shown - a warning or error can't be collapsed away. */}
      {findings.length > 0 ? (
        <div className="flex flex-col gap-2 pl-6">
          {findings.map((finding) => (
            <DoctorFindingRow key={finding.id} finding={finding} onAction={onAction} />
          ))}
        </div>
      ) : null}

      {area.nextAction ? (
        <div className="pl-6">
          <DoctorNextActionLine action={area.nextAction} />
        </div>
      ) : null}
    </div>
  );
}
