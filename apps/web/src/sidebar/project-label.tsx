import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Shared project-label rendering (plan 58 M7): renders a project's display name with a rich tooltip
 * showing the full name + path on hover. Used by BOTH the sidebar project row and the archive browser
 * row so the two surfaces never drift on how a project is named.
 *
 * Presentational only: it takes already-resolved `displayName` + `displayPath` and renders the name
 * inline (truncated). The path is shown in a rich tooltip (not inline) so it never clips or pushes
 * other content out of bounds.
 */

export interface ProjectLabelProps {
  /** The project's display name (defaults to basename; user-renamable). */
  readonly displayName: string;
  /** The full display path, or null when unknown. */
  readonly displayPath: string | null;
  /** True when the project's folder no longer exists on disk (plan 58.8): the name renders red and
   *  the tooltip names the dead path so the color is explained, not just alarming. */
  readonly missing?: boolean;
  readonly className?: string;
  /** An optional className for the muted path span (so callers control its size/tone). */
  readonly pathClassName?: string;
}

export function ProjectLabel({
  displayName,
  displayPath,
  missing = false,
  className,
  pathClassName,
}: ProjectLabelProps) {
  // Show the tooltip when the path carries MORE than the name (a basename-only path adds no info) -
  // or always for a missing project, whose tooltip is the explanation of the red label.
  const showPath = displayPath != null && (missing || displayPath !== displayName);

  const label = (
    <span
      className={cn("min-w-0 flex-1 truncate font-medium", className, missing && "text-smui-red")}
    >
      <span className="truncate">{displayName}</span>
    </span>
  );

  if (!showPath) {
    return label;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent side="right" align="center">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">{displayName}</span>
          <span className={cn("text-muted-foreground/70", pathClassName)}>{displayPath}</span>
          {missing ? <span className="text-smui-red">folder no longer exists</span> : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
