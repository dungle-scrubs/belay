import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { type CompactDisplay, compactStatusColor } from "./compact-display";

/**
 * The shared one-line compact transcript row (plan 05): renders a {@link CompactDisplay} as a single
 * dense line - a status-tinted leading icon (the spinner animates while running), a primary label, a
 * muted secondary summary, and, when the row has detail, an expand affordance that reveals `children`
 * below. Fixed row height + truncation keep it to one line and stop a status change (running -> done)
 * or a long path/command from resizing the row. It owns layout + chrome only; the icon/status/labels
 * come from the pure display contract, so every non-primary row type reads consistently.
 */

export interface CompactRowProps {
  readonly display: CompactDisplay;
  /** Whether the detail is expanded (controlled by the caller); only meaningful when `display.hasDetail`. */
  readonly expanded?: boolean;
  /** Toggles the detail; wiring it makes a detail-eligible row interactive. */
  readonly onToggle?: () => void;
  /** The detail content, rendered below the line while expanded. */
  readonly children?: ReactNode;
  readonly className?: string;
}

export function CompactRow({
  display,
  expanded = false,
  onToggle,
  children,
  className,
}: CompactRowProps) {
  const { icon: Icon, status, primary, secondary, hasDetail } = display;
  const interactive = hasDetail && onToggle !== undefined;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  const line = (
    <>
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          compactStatusColor(status),
          status === "running" && "animate-spin",
        )}
        aria-hidden
      />
      <span className="max-w-[45%] shrink-0 truncate font-medium text-foreground">{primary}</span>
      {secondary ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{secondary}</span>
      ) : (
        <span className="flex-1" />
      )}
      {hasDetail ? <Chevron className="size-3.5 shrink-0 text-muted-foreground/70" /> : null}
    </>
  );

  return (
    <div className={cn("flex flex-col", className)}>
      {interactive ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${primary}${secondary ? `, ${secondary}` : ""} (${status}); toggle details`}
          className="flex h-6 items-center gap-2 rounded px-1 text-left text-ui transition-colors hover:bg-accent/50"
        >
          {line}
        </button>
      ) : (
        <div className="flex h-6 items-center gap-2 px-1 text-ui">{line}</div>
      )}
      {expanded && children ? (
        <div className="overflow-hidden pb-1 pl-7 text-ui text-muted-foreground">{children}</div>
      ) : null}
    </div>
  );
}
