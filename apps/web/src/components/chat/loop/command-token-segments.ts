import type { CommandToken } from "@trevor/session";

export const COMMAND_TOKEN_KIND_CLASS: Record<CommandToken["kind"], string> = {
  command: "text-muted-foreground",
  flag: "rounded-[2px] bg-smui-frost-3/20 font-semibold text-smui-frost-3",
  keyword: "rounded-[2px] bg-smui-frost-3/20 font-semibold text-smui-frost-3",
  subcommand: "rounded-[2px] bg-smui-frost-3/20 font-semibold text-smui-frost-3",
  unknown: "text-smui-red",
  value: "text-foreground",
};

export interface CommandTokenSegment {
  readonly className?: string;
  readonly key: number;
  readonly kind?: CommandToken["kind"];
  readonly text: string;
}

/** Cover the whole string with colored token spans and plain text in the gaps. */
export function commandTokenSegments(
  value: string,
  tokens: readonly CommandToken[],
): CommandTokenSegment[] {
  const sorted = [...tokens].sort((a, b) => a.start - b.start);
  const segments: CommandTokenSegment[] = [];
  let cursor = 0;
  for (const token of sorted) {
    if (token.start > cursor) {
      segments.push({ key: cursor, text: value.slice(cursor, token.start) });
    }
    segments.push({
      className: COMMAND_TOKEN_KIND_CLASS[token.kind],
      key: token.start,
      kind: token.kind,
      text: value.slice(token.start, token.end),
    });
    cursor = token.end;
  }
  if (cursor < value.length) {
    segments.push({ key: cursor, text: value.slice(cursor) });
  }
  return segments;
}
