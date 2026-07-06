import type { ArtifactRef } from "@trevor/session";
import { type KeyboardEvent, type ReactNode, type RefObject, useState } from "react";
import { artifactSrc } from "@/blob";
import { segmentBySpans } from "@/lib/segment-by-spans";
import { cn } from "@/lib/utils";
import { parseImageTokens } from "./image-tokens";
import { MirrorField } from "./mirror-field";

/**
 * The image-token composer overlay (D-092 M1): a {@link MirrorField} whose mirror highlights each
 * `[Image #N]` token as a chip. The textarea keeps the real caret + editing (its text is transparent,
 * its caret visible); the mirror renders the same text with token chips, so we get attachment-token
 * syntax highlighting WITHOUT replacing the textarea with a rich editor. Token chips are the only
 * pointer targets in the mirror, so hover/focus shows the image preview while clicks + typing fall
 * through to the textarea beneath. The field/mirror alignment invariant lives in MirrorField; this
 * module supplies only the frost selection color + the image-chip mirror content.
 */

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
      // The chip must occupy the EXACT width of its text so the mirror wraps identically to the
      // transparent textarea beneath it - so the highlight is color/background/ring only (no padding,
      // no font-weight change), since any of those would widen the chip and drift it off the glyphs.
      className="group/tok pointer-events-auto relative cursor-default rounded-sm bg-smui-frost-3/20 text-smui-frost-3 ring-1 ring-inset ring-smui-frost-3/40"
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
  return segmentBySpans(
    value,
    parseImageTokens(value),
    (span, i) => <TokenChip key={`k${span.start}`} num={span.num} ref={refs[i]} srcOf={srcOf} />,
    // The mirror is the VISIBLE layer (the textarea's own glyphs are transparent), so plain runs
    // render in the foreground color; only token text is swapped for a chip.
    (text, at) => <span key={`t${at}`}>{text}</span>,
  );
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
    <MirrorField
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      textareaRef={textareaRef}
      placeholder={placeholder}
      disabled={disabled}
      selectionClassName="selection:bg-smui-frost-3/30 selection:text-transparent"
      className={className}
      overlay={
        uploading > 0 ? (
          <span className="pointer-events-none absolute right-2 top-2 text-label tracking-wider text-muted-foreground">
            uploading {uploading}…
          </span>
        ) : undefined
      }
    >
      {renderMirror(value, refs, srcOf)}
    </MirrorField>
  );
}
