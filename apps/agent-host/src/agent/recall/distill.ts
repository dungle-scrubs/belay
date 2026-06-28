import { Effect, Stream } from "effect";
import type { ChatMessage, Provider, ProviderError } from "../../providers";
import { estimateTokens } from "../../usage/breakdown";
import { cheapestReasoning } from "../reasoning-levels";
import type { RecallNeighborhood, RecallRecord } from "./types";

/**
 * The isolated recall reasoning pass (D-044 M3). Recall must not dump raw neighborhoods into
 * the main turn; instead a tool-less model step reads ONLY the recalled neighborhoods (its
 * entire context is the constructed prompt below - no tools, no file access, no main-turn
 * history) and distills an answer to the query, citing sources as `[S1]`, `[S2]`. The output
 * is bounded so a long recall cannot blow the main turn's budget.
 *
 * "Isolated subagent" here is a fresh, read-only model call with its own small context, not a
 * full delegated child session: there is nothing to write back and no tools to gate, so the
 * lighter seam (modeled on the compaction summarizer) is the right shape.
 */

/** Distilled-answer char cap - the recall finding rides back into the main turn, so keep it small. */
const FINDINGS_CHAR_CAP = 2_000;
/** Token budget for the distilled answer; the stream stops once the answer reaches it. */
const FINDINGS_TOKEN_BUDGET = 600;

export interface DistillInput {
  readonly query: string;
  readonly neighborhoods: readonly RecallNeighborhood[];
}

export interface DistillOutput {
  /** The distilled prose answer (capped), with inline `[Sn]` citations. */
  readonly text: string;
  /** 1-based source indexes the answer cited, in first-seen order (maps to neighborhoods). */
  readonly citedSources: readonly number[];
}

/** Renders one neighborhood's records as plain kind-tagged lines for the reasoning pass to read. */
function renderRecords(records: readonly RecallRecord[]): string {
  return records.map((record) => `  (${record.kind} @seq ${record.seq}) ${record.text}`).join("\n");
}

/**
 * Builds the tool-less reasoning prompt: each neighborhood is a numbered source block carrying
 * its session label, origin, turn range, and timestamp, followed by the records. The instruction
 * pins the model to answering ONLY from these sources and citing them by number.
 */
export function buildDistillPrompt(input: DistillInput): ChatMessage[] {
  const blocks = input.neighborhoods.map((neighborhood, i) => {
    const { record } = neighborhood.anchor;
    const where = `${record.session.label} · ${record.session.origin} · turns ${record.range.fromSeq}-${record.range.toSeq} · ${record.timestamp}`;
    return `[S${i + 1}] ${where}\n${renderRecords(neighborhood.records)}`;
  });

  const instruction =
    "You are recalling earlier conversation memory for this project to answer a question. " +
    "Use ONLY the numbered sources below - do not use outside knowledge or guess. Answer the " +
    "question concisely in prose, and cite each claim with the source number(s) it came from, " +
    `like [S1] or [S2]. If the sources do not contain the answer, say so plainly. Keep it under ~${FINDINGS_TOKEN_BUDGET} tokens.`;

  const sources = blocks.length > 0 ? blocks.join("\n\n") : "(no sources found)";
  return [
    {
      role: "user",
      content: `${instruction}\n\n[Question]\n${input.query}\n\n[Sources]\n${sources}`,
    },
  ];
}

/** Caps the distilled answer to the hard char backstop (keeps the head); fires only on overrun. */
function capFindings(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > FINDINGS_CHAR_CAP ? trimmed.slice(0, FINDINGS_CHAR_CAP) : trimmed;
}

/** Extracts the distinct `[Sn]` source indexes an answer cited, in first-seen order. */
export function parseCitations(text: string): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  for (const match of text.matchAll(/\[S(\d+)\]/g)) {
    const n = Number(match[1]);
    if (n > 0 && !seen.has(n)) {
      seen.add(n);
      order.push(n);
    }
  }
  return order;
}

/**
 * Runs the distillation: one tool-less model step over the reasoning prompt, reasoning forced to
 * the cheapest level (recall is extraction over given text, not open thinking). Accumulates the
 * streamed answer, stops at the token budget, caps it, and parses out the cited source indexes.
 */
export function distillRecall(
  provider: Provider,
  input: DistillInput,
): Effect.Effect<DistillOutput, ProviderError> {
  return provider
    .stream(buildDistillPrompt(input), [], cheapestReasoning(provider.reasoningLevels))
    .pipe(
      Stream.mapAccum("", (acc, event) => {
        const next = event.type === "text" ? acc + event.text : acc;
        return [next, next];
      }),
      Stream.takeUntil((acc) => estimateTokens(acc.length) >= FINDINGS_TOKEN_BUDGET),
      Stream.runFold("", (_, acc) => acc),
      Effect.map((raw) => {
        const text = capFindings(raw);
        return { text, citedSources: parseCitations(text) };
      }),
    );
}
