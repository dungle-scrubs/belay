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
    }
  | {
      readonly kind: "working";
      readonly id: string;
    };

export interface BuildTranscriptRowsInput {
  readonly toolBatches: ToolBatchLookup;
  readonly transcript: readonly Message[];
  /** Append the inline "working…" row as the LAST transcript item for a plain active turn (no task, no
   *  delegation). Task/delegation turns pin the TurnStatusHeader instead (see `activeWorkingRowVisible`).
   *  Off by default. */
  readonly working?: boolean;
}

/**
 * Converts the semantic transcript into the renderable row list consumed by the virtualizer.
 * This is deliberately not an event-log fold: `toTranscript` owns protocol semantics, while this
 * module owns UI row identity. Every returned row is a real renderable item so virtual indexes never
 * point at `null` placeholders such as read-only tool batch continuations.
 *
 * A plain active turn (no task, no delegation) appends a trailing `working` row so the live indicator
 * flows with the transcript as its last item, right under the last message. Task/delegation turns pin
 * the `TurnStatusHeader` above the checklist instead, so `working` is off for them.
 */
export function buildTranscriptRows(input: BuildTranscriptRowsInput): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const { toolBatches, transcript, working } = input;

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

  if (working) {
    rows.push({ kind: "working", id: "working" });
  }

  return rows;
}

export function transcriptRowKey(row: TranscriptRow): string {
  return row.id;
}
