import type { DoctorStatus } from "@belay/session";
import { CircleCheck, CircleDashed, CircleX, TriangleAlert } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared severity styling for the Doctor dashboard: one icon, label, and tone
 * per status, plus the small presentational atoms (icon, dot, badge) the cards
 * and summary strip reuse so green/yellow/red/muted read identically everywhere.
 */
export interface DoctorStatusMeta {
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  /** Full per-status foreground tint (ok reads green) - for the status glyph and key-fact values. */
  readonly text: string;
  /**
   * Severity-only emphasis tint: warn/error stand out, ok and not-checked stay muted. Used where a
   * row's DOMAIN element (the area icon, a finding's message) carries severity but should not light up
   * green when healthy - only call out a problem.
   */
  readonly severityText: string;
  /** Left-spine border class: colored for a problem (warn/error), transparent (but width-preserving)
   *  otherwise, so problem rows are scannable down the panel without boxing every area. */
  readonly spine: string;
  /** Solid fill for the status dot. */
  readonly dot: string;
  /** Tinted chip (low-alpha fill + matching text) for the status badge. */
  readonly chip: string;
}

export const DOCTOR_STATUS_META: Record<DoctorStatus, DoctorStatusMeta> = {
  ok: {
    label: "ok",
    icon: CircleCheck,
    text: "text-smui-green",
    severityText: "text-muted-foreground",
    spine: "border-l-2 border-l-transparent",
    dot: "bg-smui-green",
    chip: "bg-smui-green/12 text-smui-green",
  },
  warn: {
    label: "warning",
    icon: TriangleAlert,
    text: "text-smui-yellow",
    severityText: "text-smui-yellow",
    spine: "border-l-2 border-l-smui-yellow",
    dot: "bg-smui-yellow",
    chip: "bg-smui-yellow/15 text-smui-yellow",
  },
  error: {
    label: "error",
    icon: CircleX,
    text: "text-smui-red",
    severityText: "text-smui-red",
    spine: "border-l-2 border-l-smui-red",
    dot: "bg-smui-red",
    chip: "bg-smui-red/15 text-smui-red",
  },
  not_checked: {
    label: "not checked",
    icon: CircleDashed,
    text: "text-muted-foreground",
    severityText: "text-muted-foreground",
    spine: "border-l-2 border-l-transparent",
    dot: "bg-muted-foreground/60",
    chip: "bg-muted text-muted-foreground",
  },
};

/** The status glyph, tinted to its severity. */
export function StatusIcon({ status, className }: { status: DoctorStatus; className?: string }) {
  const meta = DOCTOR_STATUS_META[status];
  const Icon = meta.icon;
  return <Icon className={cn("shrink-0", meta.text, className)} />;
}

/** A solid severity dot - the lightest-weight status cue, for inline rows. */
export function StatusDot({ status, className }: { status: DoctorStatus; className?: string }) {
  return (
    <span
      className={cn("size-2 shrink-0 rounded-full", DOCTOR_STATUS_META[status].dot, className)}
      aria-hidden
    />
  );
}

/** A compact status badge: tinted chip with the status word. */
export function StatusBadge({ status, className }: { status: DoctorStatus; className?: string }) {
  const meta = DOCTOR_STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 text-label tracking-wider uppercase",
        meta.chip,
        className,
      )}
    >
      {meta.label}
    </span>
  );
}
