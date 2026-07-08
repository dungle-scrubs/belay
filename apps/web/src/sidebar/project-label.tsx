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
  readonly className?: string;
  /** An optional className for the muted path span (so callers control its size/tone). */
  readonly pathClassName?: string;
}

export function ProjectLabel({
  displayName,
  displayPath,
  className,
  pathClassName,
}: ProjectLabelProps) {
  // Show the path tooltip only when it carries MORE than the name (a basename-only path adds no info).
  const showPath = displayPath != null && displayPath !== displayName;

  const label = (
    <span className={cn("min-w-0 flex-1 truncate font-medium", className)}>
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
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
