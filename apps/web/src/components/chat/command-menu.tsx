import type { CommandSpec } from "@trevor/session";
import { cn } from "@/lib/utils";

/**
 * The slash-command autocomplete list: one row per matching command, the active
 * row highlighted, and the typed prefix highlighted within each command label.
 *
 * Purely presentational - the caller owns filtering, the active index, and
 * keyboard handling (on the input). Positioning is the caller's too: pass an
 * absolute/`bottom-full` className so it overlays above the composer instead of
 * pushing the transcript up.
 */
export function CommandMenu({
  matches,
  activeIndex,
  query,
  onPick,
  className,
}: {
  matches: readonly CommandSpec[];
  activeIndex: number;
  /** The typed slash query (includes the leading "/"); its length is the matched prefix. */
  query: string;
  onPick: (name: string) => void;
  className?: string;
}) {
  const matchLen = query.length;

  return (
    <div className={cn("overflow-hidden border border-border bg-popover shadow-lg", className)}>
      {matches.map((c, i) => {
        const display = c.usage ?? c.name;
        return (
          <button
            key={c.name}
            type="button"
            // onMouseDown (not onClick) so the composer input keeps focus through the pick.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(c.name);
            }}
            className={cn(
              "flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left",
              i === activeIndex ? "bg-accent" : "hover:bg-secondary",
            )}
          >
            <code className="text-sm font-semibold text-primary">
              {matchLen > 0 ? (
                <>
                  <span className="rounded-[2px] bg-primary/20">{display.slice(0, matchLen)}</span>
                  <span className="text-muted-foreground">{display.slice(matchLen)}</span>
                </>
              ) : (
                display
              )}
            </code>
            <span className="text-xs text-muted-foreground">{c.summary}</span>
          </button>
        );
      })}
    </div>
  );
}
