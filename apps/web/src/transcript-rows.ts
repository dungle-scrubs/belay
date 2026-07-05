import type { Message, ToolMessage } from "./transcript";

export interface ToolBatchLookup {
  readonly batchAt: ReadonlyMap<string, readonly ToolMessage[]>;
  readonly skip: ReadonlySet<string>;
}

export type TranscriptRow =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly message: Message;
      readonly compactAbove: boolean;
    }
  | {
      readonly kind: "tool_batch";
      readonly id: string;
      readonly tools: readonly ToolMessage[];
      readonly compactAbove: boolean;
    };

export interface BuildTranscriptRowsInput {
  readonly toolBatches: ToolBatchLookup;
  readonly transcript: readonly Message[];
}

/**
 * Converts the semantic transcript into the renderable row list consumed by the virtualizer.
 * This is deliberately not an event-log fold: `toTranscript` owns protocol semantics, while this
 * module owns UI row identity. Every returned row is a real renderable item so virtual indexes never
 * point at `null` placeholders such as read-only tool batch continuations.
 *
 * The in-flight indicator is NOT a transcript row: the pinned `TurnStatusHeader` (plan 50) owns the
 * live turn status above the checklist, so this fold no longer appends a scrolling `working` row.
 */
export function buildTranscriptRows(input: BuildTranscriptRowsInput): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const { toolBatches, transcript } = input;

  for (let index = 0; index < transcript.length; index += 1) {
    const message = transcript[index];
    if (!message) {
      continue;
    }
    if (message.kind === "tool" && toolBatches.skip.has(message.id)) {
      continue;
    }

    const compactAbove = message.kind === "tool" && transcript[index - 1]?.kind === "tool";
    const batch = message.kind === "tool" ? toolBatches.batchAt.get(message.id) : undefined;
    if (batch) {
      rows.push({
        kind: "tool_batch",
        id: `tool-batch:${message.id}`,
        tools: batch,
        compactAbove,
      });
      continue;
    }

    rows.push({
      kind: "message",
      id: `message:${message.id}`,
      message,
      compactAbove,
    });
  }

  return rows;
}

export function transcriptRowKey(row: TranscriptRow): string {
  return row.id;
}
