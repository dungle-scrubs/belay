import { ChevronDown, ChevronRight, LoaderIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ShimmerText } from "./action-shimmer";
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
  /** Opens a detail takeover without inline expansion. */
  readonly onAction?: () => void;
  /** Hide the repeated icon + primary label for consecutive same-tool compact rows. */
  readonly suppressPrimary?: boolean;
  /** The detail content, rendered below the line while expanded. */
  readonly children?: ReactNode;
  readonly className?: string;
}

export function CompactRow({
  display,
  expanded = false,
  onToggle,
  onAction,
  suppressPrimary = false,
  children,
  className,
}: CompactRowProps) {
  const { icon: Icon, status, primary, secondary, hasDetail } = display;
  const interactive = hasDetail && onToggle !== undefined;
  const actionable = onAction !== undefined;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const buttonLabel = `${primary}${secondary ? `, ${secondary}` : ""} (${status})${
    interactive ? "; toggle details" : actionable ? "; open detail" : ""
  }`;

  const line = (
    <>
      {suppressPrimary ? (
        <span aria-hidden />
      ) : (
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            compactStatusColor(status),
            status === "running" && Icon === LoaderIcon && "animate-spin",
          )}
          aria-hidden
        />
      )}
      {secondary ? (
        <>
          <span className="min-w-0 truncate font-medium text-foreground">
            {suppressPrimary ? (
              // The invisible copy keeps the label column the same width as the visible first row
              // (the column is content-sized), so consecutive same-tool rows stay aligned.
              <>
                <span className="sr-only">{primary}</span>
                <span aria-hidden className="invisible">
                  {primary}
                </span>
              </>
            ) : status === "running" ? (
              <ShimmerText>{primary}</ShimmerText>
            ) : (
              primary
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{secondary}</span>
        </>
      ) : (
        <span className="col-span-2 min-w-0 truncate font-medium text-foreground">{primary}</span>
      )}
      <span className="flex size-4 shrink-0 items-center justify-center">
        {interactive ? <Chevron className="size-3.5 text-muted-foreground/70" /> : null}
      </span>
    </>
  );

  // The label column is content-sized above a small floor, so the detail column starts close to
  // short tool names (bash/read) instead of a wide fixed gutter; a longer tool name pushes its
  // own detail right rather than truncating.
  const rowClassName =
    "grid h-6 grid-cols-[0.875rem_minmax(4.5rem,max-content)_minmax(0,1fr)_1rem] items-center gap-2 px-1 text-left text-ui";

  return (
    <div className={cn("flex flex-col", className)}>
      {interactive || actionable ? (
        <button
          type="button"
          onClick={onToggle ?? onAction}
          aria-expanded={interactive ? expanded : undefined}
          aria-label={buttonLabel}
          className={cn(rowClassName, "rounded-sm transition-colors hover:bg-muted/25")}
        >
          {line}
        </button>
      ) : (
        <div className={rowClassName}>{line}</div>
      )}
      {expanded && children ? (
        <div className="overflow-hidden pb-1 pl-7 text-ui text-muted-foreground">{children}</div>
      ) : null}
    </div>
  );
}
