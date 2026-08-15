import {
  type PastePayload,
  parseImageTokens,
  parsePasteTokens,
  pasteLineCount,
} from "@belay/session";
import { Copy, X } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { segmentBySpans } from "@/lib/segment-by-spans";
import { cn } from "@/lib/utils";
import { MirrorField } from "./mirror-field";

/**
 * The pasted-text-token composer overlay (10-large-paste-placeholders M4): a {@link MirrorField} whose
 * mirror highlights each `[Pasted text #N +M lines]` token as a chip, mirroring `image-token-overlay.tsx`.
 * The textarea keeps the real caret + editing (its text is transparent, its caret visible); the mirror
 * renders the same text with token chips, so the large paste collapses to a compact, inspectable chip
 * WITHOUT replacing the textarea with a rich editor.
 *
 * Paste-token chips are PURPLE - visually distinct from the FROST image-token chips (which render
 * here too, marked but non-interactive, so a mixed composer reads clearly). Hovering / focusing a
 * paste chip opens an inspection popover: line + character counts, a height/width-capped payload
 * preview, and copy + remove actions (D-007). Image previews stay the image overlay's concern.
 */

/** The payload preview is capped so a huge paste can never blow out the composer (D-007). */
const PREVIEW = "max-h-[200px] max-w-[360px] overflow-auto";

export interface PasteTokenOverlayProps {
  readonly value: string;
  /** One payload per `[Pasted text #N +M lines]` token, in reading order (for the inspection popover). */
  readonly pastes: readonly PastePayload[];
  readonly onChange: (value: string) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Remove the reading-order `index`-th pasted-text token + its payload (the chip's remove action). */
  readonly onRemove?: (index: number) => void;
  readonly className?: string;
}

/** Copies text to the clipboard, guarding the missing API (Storybook / non-secure contexts). */
function copyText(text: string): void {
  void navigator.clipboard?.writeText(text);
}

/** A paste-token chip with its hover/focus inspection popover (counts, capped preview, copy, remove). */
function PasteTokenChip({
  num,
  lines,
  payload,
  onRemove,
}: {
  num: number;
  lines: number;
  payload: PastePayload | undefined;
  onRemove?: () => void;
}) {
  const chars = payload?.text.length ?? 0;
  const actualLines = payload ? pasteLineCount(payload.text) : lines;

  return (
    <span
      data-paste-token={num}
      // The chip must occupy the EXACT width of its text so the mirror wraps identically to the
      // transparent textarea beneath it - so the highlight is color/background/ring only (no padding,
      // no font-weight change), since any of those would widen the chip and drift it off the glyphs.
      className="group/tok pointer-events-auto relative cursor-default rounded-sm bg-smui-purple/20 text-smui-purple ring-1 ring-inset ring-smui-purple/40"
    >
      [Pasted text #{num} +{lines} lines]
      {/* The popover sits directly on top of the chip (no gap) so the pointer can bridge into it to
          click copy/remove; shown on hover OR focus-within so keyboard users reach the actions too. */}
      <span className="invisible absolute bottom-full left-0 z-50 pb-1.5 opacity-0 transition-opacity group-hover/tok:visible group-hover/tok:opacity-100 group-focus-within/tok:visible group-focus-within/tok:opacity-100">
        <span className="block w-max border border-border bg-card shadow-lg">
          <span className="flex items-center justify-between gap-3 border-border border-b px-2 py-1">
            <span className="text-label tracking-wider text-muted-foreground">
              {actualLines} lines · {chars} chars
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                title="Copy pasted text"
                aria-label="Copy pasted text"
                onClick={() => payload && copyText(payload.text)}
                className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-muted-foreground hover:bg-smui-surface-1 hover:text-foreground"
              >
                <Copy className="size-3" />
              </button>
              {onRemove ? (
                <button
                  type="button"
                  title="Remove pasted text"
                  aria-label="Remove pasted text"
                  onClick={onRemove}
                  className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-muted-foreground hover:bg-smui-surface-1 hover:text-smui-red"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </span>
          </span>
          {payload ? (
            <pre
              className={cn(
                "block whitespace-pre-wrap break-words px-2 py-1.5 text-xs text-foreground",
                PREVIEW,
              )}
            >
              {payload.text}
            </pre>
          ) : (
            <span className="block px-2 py-1.5 text-xs text-muted-foreground">
              payload unavailable
            </span>
          )}
        </span>
      </span>
    </span>
  );
}

/** A non-interactive frost chip for an `[Image #N]` token, so a mixed composer marks both kinds. */
function ImageTokenChip({ num }: { num: number }) {
  return (
    <span
      data-image-token={num}
      className="rounded-sm bg-smui-frost-3/20 text-smui-frost-3 ring-1 ring-inset ring-smui-frost-3/40"
    >
      [Image #{num}]
    </span>
  );
}

type Marked =
  | {
      readonly kind: "paste";
      readonly start: number;
      readonly end: number;
      readonly num: number;
      readonly lines: number;
    }
  | { readonly kind: "image"; readonly start: number; readonly end: number; readonly num: number };

/** Splits the text into alternating plain runs and token chips (both kinds), aligned by position. */
function renderMirror(
  value: string,
  pastes: readonly PastePayload[],
  onRemove?: (index: number) => void,
): ReactNode[] {
  const marks: Marked[] = [
    ...parsePasteTokens(value).map(
      (s): Marked => ({ kind: "paste", start: s.start, end: s.end, num: s.num, lines: s.lines }),
    ),
    ...parseImageTokens(value).map(
      (s): Marked => ({ kind: "image", start: s.start, end: s.end, num: s.num }),
    ),
  ].sort((a, b) => a.start - b.start);

  // Only paste marks index into `pastes` (in reading order), so count them as they pass.
  let pasteIndex = 0;
  return segmentBySpans(
    value,
    marks,
    (mark) => {
      if (mark.kind === "paste") {
        const index = pasteIndex++;
        return (
          <PasteTokenChip
            key={`p${mark.start}`}
            num={mark.num}
            lines={mark.lines}
            payload={pastes[index]}
            onRemove={onRemove ? () => onRemove(index) : undefined}
          />
        );
      }
      return <ImageTokenChip key={`i${mark.start}`} num={mark.num} />;
    },
    // The mirror is the VISIBLE layer (the textarea's own glyphs are transparent), so plain runs
    // render in the foreground color; only token text is swapped for a chip.
    (text, at) => <span key={`t${at}`}>{text}</span>,
  );
}

export function PasteTokenOverlay({
  value,
  pastes,
  onChange,
  onKeyDown,
  textareaRef,
  placeholder,
  disabled,
  onRemove,
  className,
}: PasteTokenOverlayProps) {
  return (
    <MirrorField
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      textareaRef={textareaRef}
      placeholder={placeholder}
      disabled={disabled}
      selectionClassName="selection:bg-smui-purple/30 selection:text-transparent"
      className={className}
    >
      {renderMirror(value, pastes, onRemove)}
    </MirrorField>
  );
}
