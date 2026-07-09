import type { TranscriptRow } from "../../transcript-rows";
import { transcriptRowKey } from "../../transcript-rows";

function isCompactEligibleRow(row: TranscriptRow): boolean {
  if (row.kind !== "message") {
    return false;
  }
  const { message } = row;
  if (message.kind === "user" || message.kind === "inlineAgent") {
    return false;
  }
  if (message.kind === "assistant") {
    return message.text.trim().length === 0;
  }
  return true;
}

export interface TranscriptTurn {
  readonly id: string;
  readonly rows: readonly TranscriptRow[];
  readonly startIndex: number;
}

export const COMPACT_GAP_PB = "pb-6";
export const COMPACT_FLUSH_PB = "pb-1";
export const COMPACT_GAP_DELTA = 20;

function startsUserTurn(row: TranscriptRow): boolean {
  return row.kind === "message" && row.message.kind === "user";
}

function turnIdFor(rows: readonly TranscriptRow[]): string {
  const first = rows[0];
  if (!first) {
    return "turn:empty";
  }
  return startsUserTurn(first)
    ? `turn:${transcriptRowKey(first)}`
    : `turn:preface:${transcriptRowKey(first)}`;
}

function pushTurn(turns: TranscriptTurn[], rows: TranscriptRow[], startIndex: number): void {
  if (rows.length === 0) {
    return;
  }
  turns.push({
    id: turnIdFor(rows),
    rows: [...rows],
    startIndex,
  });
}

export function buildTranscriptTurns(rows: readonly TranscriptRow[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let currentRows: TranscriptRow[] = [];
  let currentStartIndex = 0;

  rows.forEach((row, index) => {
    if (startsUserTurn(row) && currentRows.length > 0) {
      pushTurn(turns, currentRows, currentStartIndex);
      currentRows = [];
      currentStartIndex = index;
    }
    currentRows.push(row);
  });

  pushTurn(turns, currentRows, currentStartIndex);
  return turns;
}

export function transcriptTurnKey(turn: TranscriptTurn): string {
  return turn.id;
}

export function estimateTranscriptRowSize(
  row: TranscriptRow | undefined,
  compact: boolean,
  expandedRows: ReadonlySet<string>,
): number {
  if (!row) {
    return 32;
  }
  if (
    compact &&
    isCompactEligibleRow(row) &&
    row.kind === "message" &&
    !expandedRows.has(row.message.id)
  ) {
    return 28;
  }
  if (row.kind === "tool_batch") {
    return 36 + row.tools.length * 22;
  }
  const message = row.message;
  if (message.kind === "user") {
    return 72;
  }
  if (message.kind === "tool") {
    return message.result ? 144 : 38;
  }
  if (message.kind === "assistant") {
    return Math.max(
      72,
      Math.min(520, 56 + Math.ceil((message.text.length + message.thinking.length) / 52) * 19),
    );
  }
  if (message.kind === "shell" || message.kind === "result") {
    return 120;
  }
  return 76;
}

export function estimateTranscriptTurnSize(
  turn: TranscriptTurn | undefined,
  compact: boolean,
  expandedRows: ReadonlySet<string>,
  compactGaps: readonly boolean[] | null,
): number {
  if (!turn) {
    return 32;
  }
  return turn.rows.reduce((sum, row, offset) => {
    const rowIndex = turn.startIndex + offset;
    const gap = compactGaps?.[rowIndex + 1] ? COMPACT_GAP_DELTA : 0;
    return sum + estimateTranscriptRowSize(row, compact, expandedRows) + gap;
  }, 0);
}
