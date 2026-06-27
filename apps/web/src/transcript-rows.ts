import type { QueuedPrompt } from "./send-queue";
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
      readonly interruptible: true;
      readonly startedAt?: number;
    }
  | {
      readonly kind: "queue";
      readonly id: string;
      readonly queue: readonly QueuedPrompt[];
    };

export interface BuildTranscriptRowsInput {
  readonly active: string | null;
  readonly awaitingResponse: boolean;
  readonly queue: readonly QueuedPrompt[];
  readonly toolBatches: ToolBatchLookup;
  readonly transcript: readonly Message[];
  readonly turnStartedAt: number | null;
}

/**
 * Converts the semantic transcript into the renderable row list consumed by the virtualizer.
 * This is deliberately not an event-log fold: `toTranscript` owns protocol semantics, while this
 * module owns UI row identity. Every returned row is a real renderable item so virtual indexes never
 * point at `null` placeholders such as read-only tool batch continuations.
 */
export function buildTranscriptRows(input: BuildTranscriptRowsInput): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const { active, awaitingResponse, queue, toolBatches, transcript, turnStartedAt } = input;

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

  if (active !== null || awaitingResponse) {
    rows.push({
      kind: "working",
      id: `working:${active ?? "awaiting"}`,
      interruptible: true,
      ...(turnStartedAt === null ? {} : { startedAt: turnStartedAt }),
    });
  }

  if (queue.length > 0) {
    rows.push({ kind: "queue", id: "queue", queue });
  }

  return rows;
}

export function transcriptRowKey(row: TranscriptRow): string {
  return row.id;
}
