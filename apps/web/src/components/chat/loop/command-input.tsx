import type { KeyboardEvent } from "react";
import type { CommandToken } from "@/commands/command-family";
import { cn } from "@/lib/utils";

/**
 * A single-line composer input with live syntax highlighting driven by command
 * parse tokens. A colored overlay sits exactly behind a transparent-text input
 * (the app's monospace font makes the two align character-for-character), so
 * keywords light up in the prompt as you type without a contenteditable.
 */

const KIND_CLASS: Record<CommandToken["kind"], string> = {
  command: "text-muted-foreground",
  flag: "rounded-[2px] bg-smui-frost-3/20 font-semibold text-smui-frost-3",
  keyword: "rounded-[2px] bg-smui-frost-3/20 font-semibold text-smui-frost-3",
  subcommand: "rounded-[2px] bg-smui-frost-3/20 font-semibold text-smui-frost-3",
  unknown: "text-smui-red",
  value: "text-foreground",
};

interface Segment {
  readonly key: number;
  readonly text: string;
  readonly className?: string;
}

/** Cover the whole string with colored token spans and plain text in the gaps. */
function toSegments(value: string, tokens: readonly CommandToken[]): Segment[] {
  const sorted = [...tokens].sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let cursor = 0;
  for (const token of sorted) {
    if (token.start > cursor) {
      segments.push({ key: cursor, text: value.slice(cursor, token.start) });
    }
    segments.push({
      className: KIND_CLASS[token.kind],
      key: token.start,
      text: value.slice(token.start, token.end),
    });
    cursor = token.end;
  }
  if (cursor < value.length) {
    segments.push({ key: cursor, text: value.slice(cursor) });
  }
  return segments;
}

// Shared box model so the overlay and the input occupy the exact same geometry.
const FIELD = "block w-full border px-3 py-2.5 text-ui leading-6";

export function CommandInput(props: {
  value: string;
  tokens: readonly CommandToken[];
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const { value, tokens, onChange, onKeyDown, placeholder, autoFocus, className } = props;
  const segments = toSegments(value, tokens);

  return (
    <div className={cn("relative", className)}>
      <div
        aria-hidden
        className={cn(
          FIELD,
          "pointer-events-none absolute inset-0 overflow-hidden border-transparent whitespace-pre",
        )}
      >
        {value.length === 0 ? (
          <span className="text-muted-foreground/50">{placeholder}</span>
        ) : (
          segments.map((segment) => (
            <span key={segment.key} className={segment.className}>
              {segment.text}
            </span>
          ))
        )}
      </div>
      <input
        // biome-ignore lint/a11y/noAutofocus: composer - focus so typing works immediately.
        autoFocus={autoFocus}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={cn(
          FIELD,
          "border-input bg-background text-transparent caret-foreground outline-none transition-colors placeholder:text-transparent focus:border-ring",
        )}
      />
    </div>
  );
}
