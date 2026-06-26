import type { ArtifactRef } from "@trevor/session";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useState,
} from "react";
import { artifactSrc } from "@/blob";
import { cn } from "@/lib/utils";
import { parseImageTokens } from "./image-tokens";

/**
 * The image-token composer overlay (D-092 M1): a plain textarea with `[Image #N]` tokens highlighted
 * by a mirror layer drawn on top. The textarea keeps the real caret + editing (its text is
 * transparent, its caret visible); the mirror renders the same text with token chips, so we get
 * attachment-token syntax highlighting WITHOUT replacing the textarea with a rich editor. Token chips
 * are the only pointer targets in the mirror, so hover/focus shows the image preview while clicks +
 * typing fall through to the textarea beneath.
 *
 * The overlay and textarea MUST share identical typography, padding, and wrapping (the `FIELD`
 * classes) so the highlighted spans sit exactly under the textarea's glyphs.
 */

/** Typography + box the textarea and its mirror share so the highlight tracks the text exactly. */
const FIELD = "w-full whitespace-pre-wrap break-words px-3 py-2 text-sm leading-6 font-sans";

/** Preview dimensions: the plan caps the hover/focus preview at 300x300 with preserved aspect. */
const PREVIEW = "max-w-[300px] max-h-[300px]";

export interface ImageTokenOverlayProps {
  readonly value: string;
  /** One ref per `[Image #N]` token, in reading order (for the hover/focus preview). */
  readonly refs: readonly ArtifactRef[];
  readonly onChange: (value: string) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Count of uploads still in flight (a pending token state shows while > 0). */
  readonly uploading?: number;
  /** Resolves an artifact hash to an image URL; defaults to the blob-store `artifactSrc` (override
   *  in Storybook/tests to serve a local/data URL instead of the running blob store). */
  readonly srcOf?: (hash: string) => string;
  readonly className?: string;
}

/** A token chip in the mirror with its hover/focus image preview popover. */
function TokenChip({
  num,
  ref,
  srcOf,
}: {
  num: number;
  ref: ArtifactRef | undefined;
  srcOf: (hash: string) => string;
}) {
  const [broken, setBroken] = useState(false);
  const previewable = ref?.kind === "image" && !broken;

  return (
    // Decorative chip inside the aria-hidden mirror: the real, accessible text (including the
    // literal "[Image #N]") lives in the textarea, so the chip carries no role/label/tabindex - it
    // is a visual highlight + hover preview only. `data-image-token` is a test/integration hook.
    <span
      data-image-token={num}
      className="group/tok pointer-events-auto relative cursor-default rounded-sm bg-smui-frost-3/15 px-0.5 font-medium text-smui-frost-3 ring-1 ring-inset ring-smui-frost-3/30"
    >
      [Image #{num}]
      <span className="invisible absolute bottom-full left-0 z-50 mb-1.5 opacity-0 transition-opacity group-hover/tok:visible group-hover/tok:opacity-100">
        <span className="block border border-border bg-card p-1 shadow-lg">
          {previewable ? (
            <img
              src={srcOf(ref.hash)}
              alt={ref?.name ?? `image ${num}`}
              onError={() => setBroken(true)}
              className={cn("block object-contain", PREVIEW)}
            />
          ) : (
            <span className="block px-2 py-1.5 text-xs text-muted-foreground">
              {ref ? "preview unavailable" : "uploading…"}
            </span>
          )}
        </span>
      </span>
    </span>
  );
}

/** Splits the text into alternating plain runs and token chips, aligning each token to its ref. */
function renderMirror(
  value: string,
  refs: readonly ArtifactRef[],
  srcOf: (hash: string) => string,
): ReactNode[] {
  const spans = parseImageTokens(value);
  const out: ReactNode[] = [];
  let last = 0;
  spans.forEach((span, i) => {
    if (span.start > last) {
      out.push(
        <span key={`t${last}`} className="text-transparent">
          {value.slice(last, span.start)}
        </span>,
      );
    }
    out.push(<TokenChip key={`k${span.start}`} num={span.num} ref={refs[i]} srcOf={srcOf} />);
    last = span.end;
  });
  out.push(
    <span key="tail" className="text-transparent">
      {value.slice(last)}
      {/* A trailing newline needs a placeholder char so the mirror's last line height matches. */}
      {value.endsWith("\n") ? "​" : ""}
    </span>,
  );
  return out;
}

export function ImageTokenOverlay({
  value,
  refs,
  onChange,
  onKeyDown,
  textareaRef,
  placeholder,
  disabled,
  uploading = 0,
  srcOf = artifactSrc,
  className,
}: ImageTokenOverlayProps) {
  return (
    <div className={cn("relative", className)}>
      {/* The mirror sits ON TOP: token chips are hover/focus targets; plain runs are transparent +
          click-through, so the textarea beneath owns the caret, selection, and typing. */}
      <div
        aria-hidden
        className={cn(
          FIELD,
          "pointer-events-none absolute inset-0 overflow-hidden text-foreground",
        )}
      >
        {renderMirror(value, refs, srcOf)}
      </div>

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        spellCheck={false}
        // Transparent glyphs (the mirror draws the visible text) but a visible caret + selection.
        className={cn(
          FIELD,
          "relative resize-none bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground",
          "selection:bg-smui-frost-3/30 selection:text-transparent",
        )}
      />

      {uploading > 0 ? (
        <span className="pointer-events-none absolute right-2 top-2 text-label tracking-wider text-muted-foreground">
          uploading {uploading}…
        </span>
      ) : null}
    </div>
  );
}
