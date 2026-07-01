import {
  type CommandPresentation,
  type CommandToken,
  commandPresentation,
  LOOP_COMMAND_NAMES,
  LOOP_FAMILY,
  parseLoopCommand,
} from "@trevor/session";
import { useMemo } from "react";
import { lineEnd, lineStart } from "../../../text-lines";

export interface LoopPreview {
  readonly line: string;
  readonly lineEnd: number;
  readonly lineStart: number;
  readonly tokens: readonly CommandToken[];
  readonly view: CommandPresentation;
}

function activeLineSpan(
  value: string,
  caret: number,
): { readonly end: number; readonly start: number } {
  const boundedCaret = Math.max(0, Math.min(caret, value.length));
  return {
    end: lineEnd(value, boundedCaret),
    start: lineStart(value, boundedCaret),
  };
}

function isLoopLine(line: string): boolean {
  const head = line.trimStart().split(/\s+/, 1)[0] ?? "";
  return LOOP_COMMAND_NAMES.includes(head as (typeof LOOP_COMMAND_NAMES)[number]);
}

export function loopPreviewForLine(value: string, caret: number): LoopPreview | null {
  const span = activeLineSpan(value, caret);
  const line = value.slice(span.start, span.end);
  if (!isLoopLine(line)) {
    return null;
  }
  const parsed = parseLoopCommand(line);
  return {
    line,
    lineEnd: span.end,
    lineStart: span.start,
    tokens: parsed.tokens,
    view: commandPresentation(parsed, LOOP_FAMILY),
  };
}

export function useLoopPreview(value: string, caret: number): LoopPreview | null {
  return useMemo(() => loopPreviewForLine(value, caret), [caret, value]);
}
