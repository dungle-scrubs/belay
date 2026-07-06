import type { ChangeEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";

/**
 * The mirror-highlight field primitive (deepen C-19): a plain `<textarea>` whose glyphs are transparent
 * (but caret + selection stay visible) with a pixel-aligned mirror `<div>` drawn on top that re-renders
 * the same text as highlight chips. The textarea and mirror MUST share identical typography, padding,
 * and wrapping (the `FIELD` classes) or the highlight drifts off the glyphs - this primitive owns that
 * geometry invariant, the transparent-text / visible-caret trick, the tail placeholder that keeps an
 * empty or newline-ending value at full last-line height, and the stacking (textarea underneath so the
 * mirror's chips can be hover/focus targets while typing + clicks fall through to the textarea).
 *
 * The composer's image-token and paste-token overlays are both this field with a different
 * `selectionClassName` and mirror content; a new highlighted composer supplies those two and reuses the
 * alignment invariant rather than re-deriving it. (The loop's single-line command input is a DIFFERENT
 * shape - an `<input>` with the mirror on top and no wrapping/tail - so it keeps its own scaffolding.)
 */

/** Typography + box the textarea and its mirror share so the highlight tracks the text exactly. */
const FIELD = "w-full whitespace-pre-wrap break-words px-3 py-2 text-sm leading-6 font-sans";

export interface MirrorFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** The selection-highlight classes (frost vs purple), so each token kind themes its own selection. */
  readonly selectionClassName: string;
  /** The visible mirror content: the plain runs + highlight chips (typically from `segmentBySpans`). */
  readonly children: ReactNode;
  /** Optional content stacked above the mirror (e.g. the image composer's "uploading N…" badge). */
  readonly overlay?: ReactNode;
  readonly className?: string;
}

export function MirrorField({
  value,
  onChange,
  onKeyDown,
  textareaRef,
  placeholder,
  disabled,
  selectionClassName,
  children,
  overlay,
  className,
}: MirrorFieldProps) {
  return (
    <div className={cn("relative", className)}>
      {/* The textarea is the BOTTOM layer (absolute, filling the box the mirror sizes): transparent
          glyphs but a visible caret + selection, and it owns typing. It is painted under the mirror so
          the mirror's chips can be hover/focus targets - the caret shows through the mirror's gaps. */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        className={cn(
          FIELD,
          "absolute inset-0 h-full resize-none overflow-hidden bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground",
          selectionClassName,
        )}
      />

      {/* The mirror is the VISIBLE, in-flow layer: it sizes the box to the wrapped content (so the
          textarea beneath always matches - no scroll, no height drift) and draws the prose + chips on
          top. pointer-events-none lets clicks/typing fall through to the textarea; only chips opt back
          in (pointer-events-auto) to catch hover/focus. */}
      <div aria-hidden className={cn(FIELD, "pointer-events-none relative text-foreground")}>
        {children}
        {/* An empty value or trailing newline needs a placeholder char so the mirror keeps a full last
            line height (the mirror sizes the box, so a collapsed line would shrink the field). */}
        {value === "" || value.endsWith("\n") ? "​" : ""}
      </div>

      {overlay}
    </div>
  );
}
