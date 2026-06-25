import type { CommandFamilyDescriptor, CommandParseResult } from "@/commands/command-family";
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

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden border border-border bg-popover shadow-lg",
        className,
      )}
    >
      <div className="px-3 py-2.5">
        <LoopBuilder parse={parse} />
      </div>
      <div className="border-t border-border bg-secondary/30 px-3 py-2">
        <LoopKeywords descriptor={descriptor} usedKeywords={parse.usedKeywords} />
      </div>
    </div>
  );
}
