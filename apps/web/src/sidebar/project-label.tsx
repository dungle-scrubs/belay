import { cn } from "@/lib/utils";

/**
 * Shared project-label rendering (plan 58 M7): renders a project's display name and, when it adds
 * disambiguation, its display path. Used by BOTH the sidebar project row and the archive browser row
 * so the two surfaces never drift on how a project is named.
 *
 * Presentational only: it takes already-resolved `displayName` + `displayPath` and renders them. The
 * path is shown when it differs from the name (i.e. it carries more than the basename); a basename-only
 * path adds no information and is omitted to avoid a redundant "app app" label.
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
  // Show the path only when it carries MORE than the name (a basename-only path adds no info).
  const showPath = displayPath != null && displayPath !== displayName;
  return (
    <span className={cn("min-w-0 truncate", className)}>
      <span className="truncate font-medium">{displayName}</span>
      {showPath ? (
        <span className={cn("truncate text-muted-foreground/70", pathClassName)}>
          {" "}
          {displayPath}
        </span>
      ) : null}
    </span>
  );
}
