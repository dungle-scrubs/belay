import { decodeTrevorEvent, type SessionEvent } from "@belay/session";
import type { RecallRecord, RecallSessionRef } from "./types";

/**
 * Builds the recallable corpus from durable session event logs. A record is one searchable
 * conversational unit - a user message, an assistant reply, a tool result, or a compaction
 * fold summary - carrying a stable pointer back to its place in the log. This module is pure
 * over decoded events: no transport, no IO, so the record model + exclusion rules are unit
 * testable on synthetic logs.
 *
 * The load-bearing rule is the exclusion (D-044): the active prompt already carries the
 * current session's recent turns verbatim plus its rolling fold summary, so recall must NOT
 * re-surface them. Current-session records are therefore restricted to the compacted-away
 * span (seq <= the latest fold's throughSeq) with the fold summaries themselves dropped,
 * while sibling sessions - none of which is in the active prompt - contribute in full.
 *
 * Responsible for: building the recallable record corpus from decoded session logs, enforcing
 * the current-session exclusion rule.
 */

/** Per-record text cap so one huge tool result cannot dominate the index or an excerpt. */
const TEXT_CAP = 4_000;

/** Collapses runs of whitespace and trims, then caps - the normalized searchable form. */
function normalize(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > TEXT_CAP ? collapsed.slice(0, TEXT_CAP) : collapsed;
}

/** A single-seq range for a non-fold record (its anchor IS its span). */
function point(seq: number): { readonly fromSeq: number; readonly toSeq: number } {
  return { fromSeq: seq, toSeq: seq };
}

/**
 * Projects one session's durable events into recall records, dropping events that carry no
 * recallable conversational content (lifecycle, presence, progress, deltas). Decoding is the
 * shared permissive `decodeTrevorEvent`, so an unknown or malformed event is simply skipped.
 */
export function buildRecords(
  events: readonly SessionEvent[],
  session: RecallSessionRef,
): RecallRecord[] {
  const records: RecallRecord[] = [];

  for (const event of events) {
    const decoded = decodeTrevorEvent(event);
    if (!decoded) {
      continue;
    }

    const base = {
      id: `${session.sessionId}#${event.seq}`,
      session,
      seq: event.seq,
      timestamp: event.createdAt,
    } as const;

    if (decoded.type === "user.message") {
      const text = normalize(decoded.text);
      if (text) {
        records.push({
          ...base,
          range: point(event.seq),
          kind: "user",
          runId: null,
          tool: null,
          foldId: null,
          text,
        });
      }
    } else if (decoded.type === "assistant.completed") {
      // A cancelled/interrupted/empty turn carries no real reply - skip it so recall never
      // surfaces a blank "the model said nothing here" record.
      const text = normalize(decoded.text);
      if (text && !decoded.cancelled && !decoded.interrupted) {
        records.push({
          ...base,
          range: point(event.seq),
          kind: "assistant",
          runId: decoded.runId,
          tool: null,
          foldId: null,
          text,
        });
      }
    } else if (decoded.type === "tool.completed") {
      const result = normalize(decoded.result);
      if (result) {
        const text = normalize(`${decoded.name}: ${result}`);
        records.push({
          ...base,
          range: point(event.seq),
          kind: "tool",
          runId: decoded.runId,
          tool: decoded.name,
          foldId: null,
          text,
        });
      }
    } else if (decoded.type === "context.compacted") {
      const text = normalize(decoded.summary);
      if (text) {
        records.push({
          ...base,
          range: {
            fromSeq: decoded.manifest.turnRange.fromSeq,
            toSeq: decoded.manifest.turnRange.toSeq,
          },
          kind: "fold",
          runId: null,
          tool: null,
          foldId: decoded.foldId,
          text,
        });
      }
    }
  }

  return records;
}

/** One session's contribution to the corpus: its ref, its events, and (current only) fold state. */
export interface SessionInput {
  readonly session: RecallSessionRef;
  readonly events: readonly SessionEvent[];
  /**
   * The current session's latest fold throughSeq: events with seq <= this are compacted-away
   * (recallable), events with seq > this are still verbatim in the active prompt (excluded).
   * `null`/omitted means no fold yet, so the current session contributes nothing - everything
   * it holds is already in the prompt. Ignored for sibling sessions.
   */
  readonly currentFoldThroughSeq?: number | null;
}

/**
 * Assembles the full recall corpus across the current session and its project siblings,
 * applying the active-prompt exclusion. The current session yields only its compacted-away,
 * non-summary detail; siblings yield everything. The latest fold's `throughSeq` is the
 * boundary, read from the live host - so as compaction advances, more current-session detail
 * becomes recallable and the active-prompt tail stays excluded.
 */
export function assembleCorpus(inputs: readonly SessionInput[]): RecallRecord[] {
  const records: RecallRecord[] = [];

  for (const input of inputs) {
    const built = buildRecords(input.events, input.session);

    if (input.session.origin === "current-compacted") {
      const through = input.currentFoldThroughSeq ?? null;
      if (through == null) {
        continue; // no fold yet: every current-session turn is still in the active prompt
      }
      for (const record of built) {
        // Drop the fold SUMMARIES (they ride in the active prompt) and any turn past the fold
        // boundary (still verbatim in the prompt) - keep only the compacted-away detail.
        if (record.kind !== "fold" && record.range.toSeq <= through) {
          records.push(record);
        }
      }
    } else {
      records.push(...built);
    }
  }

  return records;
}
