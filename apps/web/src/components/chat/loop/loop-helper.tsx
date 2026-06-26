import {
  type CommandFamilyDescriptor,
  type CommandParseResult,
  commandPresentation,
} from "@/commands/command-family";
import { cn } from "@/lib/utils";
import { LoopBuilder } from "./loop-builder";
import { LoopKeywords } from "./loop-keywords";

/**
 * The helper that floats above the composer while a `/loop` line is being typed:
 * the live builder output, then the horizontal keyword strip beneath it. No
 * header, no buttons - Enter in the composer creates the loop.
 *
 * Presentational: the caller parses on every keystroke and passes the result.
 */
export function LoopHelper(props: {
  descriptor: CommandFamilyDescriptor;
  parse: CommandParseResult;
  className?: string;
}) {
  const { descriptor, parse, className } = props;
  // The single presentation view-model both panels render from (chips + rows + errors + ready).
  const view = commandPresentation(parse, descriptor);

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
