import type { CommandKeywordChip } from "@belay/session";
import { cn } from "@/lib/utils";

/**
 * A single horizontal row of keyword chips for a command family. Each chip lights
 * up once that keyword is used in the current input, so the next thing to type
 * stands out. No prose - just the grammar at a glance, beneath the builder. Pure
 * render: the `used` state is precomputed in the command presentation view-model.
 */
export function LoopKeywords(props: { chips: readonly CommandKeywordChip[]; className?: string }) {
  const { chips, className } = props;

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {chips.map((chip) => (
        <code
          key={chip.keyword}
          className={cn(
            "rounded-sm px-1.5 py-0.5 text-label transition-colors",
            // primary/primary-foreground is a guaranteed-contrast pair (dark text
            // on the light fill in dark mode, and the inverse in light mode).
            chip.used
              ? "bg-primary font-semibold text-primary-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          {chip.keyword}
          {chip.arg ? (
            // On a used chip the fill is light, so keep the arg dark too (just
            // un-bold); only dim the arg on the muted, unused chips.
            <span className={chip.used ? "font-normal" : "opacity-60"}> {chip.arg}</span>
          ) : null}
        </code>
      ))}
    </div>
  );
}
