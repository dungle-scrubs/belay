import type { CommandPresentation } from "@belay/session";
import { cn } from "@/lib/utils";
import { LoopBuilder } from "./loop-builder";
import { LoopKeywords } from "./loop-keywords";

/**
 * The helper that floats above the composer while a `/loop` line is being typed:
 * the live builder output, then the horizontal keyword strip beneath it. No
 * header, no buttons - Enter in the composer creates the loop.
 *
 * Presentational: the caller passes the loop presentation view-model.
 */
export function LoopHelper(props: { view: CommandPresentation; className?: string }) {
  const { view, className } = props;

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden border border-border bg-popover shadow-lg",
        className,
      )}
    >
      <div className="px-3 py-2.5">
        <LoopBuilder view={view} />
      </div>
      <div className="border-t border-border bg-secondary/30 px-3 py-2">
        <LoopKeywords chips={view.chips} />
      </div>
    </div>
  );
}
