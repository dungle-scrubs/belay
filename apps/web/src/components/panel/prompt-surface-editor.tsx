import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * The full-surface prompt editor (02.12): a takeover that fills the transcript + composer column with
 * a large editable text area, for viewing/editing long prompts with room. Dismissed by the upper-left
 * back button, Escape, or Cmd/Ctrl-Enter - all of which confirm (hand the current text back to the
 * opener). Purely presentational: open/close + text state live in `usePromptEditor`, and PanelHost
 * renders this through the same overlay slot the model chooser uses.
 */
export function PromptSurfaceEditor({
  text,
  title,
  onTextChange,
  onConfirm,
}: {
  readonly text: string;
  readonly title?: string;
  readonly onTextChange: (text: string) => void;
  /** Back / Escape / Cmd-Enter / Done - confirms the current text and closes. */
  readonly onConfirm: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea on open with the caret at the end, so the user can keep typing immediately.
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  return (
    <div data-prompt-editor className="flex h-full flex-col gap-3 p-3">
      <header className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          aria-label="Back"
          className="hover:bg-accent hover:text-accent-foreground flex items-center gap-1 rounded-md px-2 py-1 text-sm transition-colors"
        >
          <ArrowLeftIcon className="size-4" />
          Back
        </button>
        <span className="text-label tracking-wider text-muted-foreground/80">
          {title ?? "Edit prompt"}
        </span>
      </header>

      <textarea
        ref={ref}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={(e) => {
          // Escape (save and close) and Cmd/Ctrl-Enter (save) both confirm; plain Enter is a newline.
          if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
            e.preventDefault();
            onConfirm();
          }
        }}
        spellCheck={false}
        className={cn(
          "flex-1 resize-none rounded-md border border-border bg-background p-3 font-mono text-sm text-foreground",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
        placeholder="Write your prompt…"
      />

      <footer className="flex shrink-0 items-center justify-between text-label text-muted-foreground/70">
        <span>Esc or ⌘↵ to save and close</span>
        <button
          type="button"
          onClick={onConfirm}
          className="bg-primary text-primary-foreground rounded-md px-3 py-1 text-sm font-medium transition-colors hover:opacity-90"
        >
          Done
        </button>
      </footer>
    </div>
  );
}
