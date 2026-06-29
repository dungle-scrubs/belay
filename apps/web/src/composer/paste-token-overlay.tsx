import {
  type PastePayload,
  parseImageTokens,
  parsePasteTokens,
  pasteLineCount,
} from "@trevor/session";
import { Copy, X } from "lucide-react";
import type { ChangeEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";

/**
 * The pasted-text-token composer overlay (10-large-paste-placeholders M4): a plain textarea with
 * `[Pasted text #N +M lines]` tokens highlighted by a mirror layer drawn on top, mirroring
 * `image-token-overlay.tsx`. The textarea keeps the real caret + editing (its text is transparent,
 * its caret visible); the mirror renders the same text with token chips, so the large paste collapses
 * to a compact, inspectable chip WITHOUT replacing the textarea with a rich editor.
 *
 * Paste-token chips are PURPLE - visually distinct from the FROST image-token chips (which render
 * here too, marked but non-interactive, so a mixed composer reads clearly). Hovering / focusing a
 * paste chip opens an inspection popover: line + character counts, a height/width-capped payload
 * preview, and copy + remove actions (D-007). Image previews stay the image overlay's concern.
 */

/** Typography + box the textarea and its mirror share so the highlight tracks the text exactly. */
const FIELD = "w-full whitespace-pre-wrap break-words px-3 py-2 text-sm leading-6 font-sans";

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
      className="group/tok pointer-events-auto relative cursor-default rounded-sm bg-smui-purple/15 px-0.5 font-medium text-smui-purple ring-1 ring-inset ring-smui-purple/30"
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
      className="rounded-sm bg-smui-frost-3/15 px-0.5 font-medium text-smui-frost-3 ring-1 ring-inset ring-smui-frost-3/30"
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

  const out: ReactNode[] = [];
  let last = 0;
  let pasteIndex = 0;
  for (const mark of marks) {
    if (mark.start > last) {
      out.push(
        <span key={`t${last}`} className="text-transparent">
          {value.slice(last, mark.start)}
        </span>,
      );
    }
    if (mark.kind === "paste") {
      const index = pasteIndex++;
      out.push(
        <PasteTokenChip
          key={`p${mark.start}`}
          num={mark.num}
          lines={mark.lines}
          payload={pastes[index]}
          onRemove={onRemove ? () => onRemove(index) : undefined}
        />,
      );
    } else {
      out.push(<ImageTokenChip key={`i${mark.start}`} num={mark.num} />);
    }
    last = mark.end;
  }
  out.push(
    <span key="tail" className="text-transparent">
      {value.slice(last)}
      {/* A trailing newline needs a placeholder char so the mirror's last line height matches. */}
      {value.endsWith("\n") ? "​" : ""}
    </span>,
  );
  return out;
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
        {renderMirror(value, pastes, onRemove)}
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
        className={cn(
          FIELD,
          "relative resize-none bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground",
          "selection:bg-smui-purple/30 selection:text-transparent",
        )}
      />
    </div>
  );
}
