import { cn } from "@/lib/utils";
import { Markdown } from "@/markdown";

/**
 * The shared markdown body for chat surfaces: the app's `Markdown` parser/sanitizer wrapped in the
 * `.smui-md` re-theme (SMUI tokens, see index.css) plus the muted/foreground color. It defaults to
 * `text-sm`; pass `className` to override the size or spacing (e.g. the compact queued-prompts row
 * uses `text-[11px] leading-5`), merged via `cn` so the override wins. One source of truth, so a
 * wrapper/class change propagates to every markdown body at once.
 */
export function MarkdownBody({
  text,
  muted = false,
  className,
  mermaid = false,
}: {
  readonly text: string;
  readonly muted?: boolean;
  readonly className?: string;
  readonly mermaid?: boolean;
}) {
  return (
    <div
      className={cn(
        "smui-md text-sm",
        muted ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      <Markdown text={text} muted={muted} mermaid={mermaid} />
    </div>
  );
}
