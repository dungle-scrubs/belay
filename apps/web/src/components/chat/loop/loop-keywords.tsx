import type { CommandFamilyDescriptor } from "@/commands/command-family";
import { cn } from "@/lib/utils";

/**
 * A single horizontal row of keyword chips for a command family. Each chip lights
 * up once that keyword is used in the current input, so the next thing to type
 * stands out. No prose - just the grammar at a glance, beneath the builder.
 */
export function LoopKeywords(props: {
  descriptor: CommandFamilyDescriptor;
  usedKeywords?: readonly string[];
  className?: string;
}) {
  const { descriptor, usedKeywords = [], className } = props;
  const used = new Set(usedKeywords);

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {descriptor.keywords.map((keyword) => {
        const isUsed = used.has(keyword.keyword);
        return (
          <code
            key={keyword.keyword}
            className={cn(
              "rounded-sm px-1.5 py-0.5 text-label transition-colors",
              // primary/primary-foreground is a guaranteed-contrast pair (dark text
              // on the light fill in dark mode, and the inverse in light mode).
              isUsed
                ? "bg-primary font-semibold text-primary-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {keyword.keyword}
            {keyword.arg ? (
              // On a used chip the fill is light, so keep the arg dark too (just
              // un-bold); only dim the arg on the muted, unused chips.
              <span className={isUsed ? "font-normal" : "opacity-60"}> {keyword.arg}</span>
            ) : null}
          </code>
        );
      })}
    </div>
  );
}
