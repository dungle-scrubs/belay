import type { CommandArgPreview } from "@/derive";
import { cn } from "@/lib/utils";

/**
 * The live substitution preview for a file-loaded custom command (plan 44.5 M6): as the user types
 * `/fix 123`, this overlays the composer with the command's expanded body - exactly what the host will
 * submit as the prompt - so the `$0`/`$ARGUMENTS` placeholders are resolved before Enter is pressed.
 *
 * Purely presentational: the caller derives the {@link CommandArgPreview} (via `commandArgPreview`, the
 * shared `@trevor/session` `expandArgs` engine) and owns when it shows. Positioning is the caller's too -
 * pass an absolute/`bottom-full` class so it floats above the composer like the slash + file menus.
 */
export function CommandPreview({
  preview,
  className,
}: {
  readonly preview: CommandArgPreview;
  readonly className?: string;
}) {
  return (
    <div className={cn("overflow-hidden border border-border bg-popover shadow-lg", className)}>
      <div className="flex items-baseline gap-2 border-b border-border px-3 py-1.5">
        <code className="text-sm font-semibold text-primary">{preview.command}</code>
        {preview.argumentHint ? (
          <span className="text-xs text-muted-foreground">{preview.argumentHint}</span>
        ) : null}
        <span className="ml-auto text-[0.65rem] uppercase tracking-wide text-muted-foreground">
          preview
        </span>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap px-3 py-2 text-sm text-foreground">
        {preview.text}
      </pre>
      {preview.missing.length > 0 ? (
        <div className="border-t border-border px-3 py-1 text-xs text-muted-foreground">
          waiting on {preview.missing.join(", ")}
        </div>
      ) : null}
    </div>
  );
}
