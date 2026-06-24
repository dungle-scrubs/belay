import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface ToolSectionProps {
  /** Left side of the header (e.g. a file path). Omitted when the row above already names it. */
  title?: ReactNode;
  /** Right side of the header (e.g. a +N -M diff stat, or a provider · count line). */
  meta?: ReactNode;
  /** Whether the section starts expanded; the global compact setting drives this. */
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * A bordered, collapsible content box with a titled header - the one container every
 * result-bearing tool renders into (a diff per file, a search-result list), so they
 * share a single visual language. Generalized from multi_edit's per-file box; the
 * leading chevron folds just this section, independent of the enclosing tool row.
 */
export function ToolSection({
  title,
  meta,
  defaultOpen = true,
  children,
  className,
}: ToolSectionProps) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className={cn("overflow-hidden border border-border bg-smui-surface-1", className)}
    >
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-2 py-1.5">
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <div className="flex-1 truncate text-left text-xs text-foreground">{title}</div>
        {meta ? <span className="shrink-0 text-label tracking-wider">{meta}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border">{children}</CollapsibleContent>
    </Collapsible>
  );
}
