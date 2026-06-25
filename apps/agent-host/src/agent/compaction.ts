import { Effect, Stream } from "effect";
import type { ChatMessage, Provider, ProviderError } from "../providers";
import { CHARS_PER_TOKEN, estimateTokens } from "../usage/tokens";
import { cheapestReasoning } from "./recovery";

/**
 * Cross-turn compaction's summarizer (D-043): a tool-less model call that folds the prior rolling
 * summary plus a run of older turns into the next rolling summary. The summary rides in every
 * later prompt (history-projection.ts injects it as the fold's synthetic assistant message), so it
 * must stay small - the model is asked to re-summarize to a fixed budget as more folds in, never to
 * grow it, and a hard char cap backstops the model not honoring that.
 *
 * The provider is the routing SEAM: the caller passes the turn's provider for now; per-fold
 * local↔cloud routing (D-046) reuses this entry point later without changing the call sites.
 */

/** Target size of the rolling summary, in tokens (it rides in every later prompt - keep it small).
 *  The single source of this budget: the compaction planner (compactor.ts) imports it so planning
 *  and summarization can never disagree on how big the summary is. */
export const SUMMARY_TOKEN_BUDGET = 1_000;
/** Hard cap on the summary length (chars), independent of whether the model respected the budget. */
const SUMMARY_CHAR_CAP = SUMMARY_TOKEN_BUDGET * CHARS_PER_TOKEN;

export interface CompactionInput {
  /** The prior rolling summary, or null for the first fold in a session. */
  readonly priorSummary: string | null;
  /**
   * The turns being folded into the summary (the prompt projection for those turns). The pinned
   * goal + task list are NOT included here - they are re-injected separately (D-040) and the
   * instruction tells the model not to restate them.
   */
  readonly foldedTurns: readonly ChatMessage[];
}

/** Renders the folded turns as plain role-tagged text for the summarizer to read. */
function renderTurns(turns: readonly ChatMessage[]): string {
  return turns.map((message) => `${message.role}: ${message.content}`).join("\n\n");
}

/**
 * Builds the tool-less summarization prompt: one user message instructing the model to fold the
 * prior summary + the given turns into the next rolling summary. The instruction is recall-aware
 * (names files/commands/errors and what is dropped-but-recallable, for session recall D-044) and
 * explicitly does NOT restate the pinned goal or task list (re-injected separately, D-040).
 */
export function buildSummaryPrompt(input: CompactionInput): ChatMessage[] {
  const sections = [
    "Summarize the conversation below into a single compact rolling summary for your own future " +
      `context, at most ~${SUMMARY_TOKEN_BUDGET} tokens. Capture: key decisions, the current ` +
      "state, open threads, and named references (files, commands, errors). Note what detail is " +
      "being dropped but could be recalled later. Do NOT restate the original goal or the task " +
      "list - they are pinned separately. Write only the summary, with no preamble.",
  ];
  if (input.priorSummary) {
    sections.push(`[Previous summary]\n${input.priorSummary}`);
  }
  sections.push(`[Conversation to fold]\n${renderTurns(input.foldedTurns)}`);
  return [{ role: "user", content: sections.join("\n\n") }];
}

/** Caps the summary to the hard char backstop (keeps the head); fires only if the model overran. */
function capSummary(summary: string): string {
  const trimmed = summary.trim();
  return trimmed.length > SUMMARY_CHAR_CAP ? trimmed.slice(0, SUMMARY_CHAR_CAP) : trimmed;
}

/**
 * Produces the next rolling summary: one tool-less model step over the summarization prompt, with
 * reasoning forced to the cheapest level (summarizing is mechanical, not a thinking task). Caps the
 * result to the ~1k-token budget.
 *
 * `onProgress` is called as the summary streams, with the tokens produced so far and the budget, so
 * the host can surface an honest live progress bar (real tokens streamed ÷ the budget, never a
 * predicted percentage). It is advisory - a no-op when omitted.
 *
 * Single-pass for v1: the whole fold region goes in one prompt. A region larger than the
 * summarizer's own window would need oldest-chunk-first map-reduce (summarize chunks, then
 * summarize the summaries) - deferred; v1 assumes the fold region fits.
 */
export function summarize(
  provider: Provider,
  input: CompactionInput,
  onProgress?: (tokens: number, budget: number) => void,
): Effect.Effect<string, ProviderError> {
  const fold = provider
    .stream(buildSummaryPrompt(input), [], cheapestReasoning(provider.reasoningLevels))
    .pipe(
      // Thread the streamed text into a running summary - one accumulator emitted per event (no seed),
      // so progress is reported once per streamed chunk.
      Stream.mapAccum("", (acc, event) => {
        const next = event.type === "text" ? acc + event.text : acc;
        return [next, next];
      }),
      Stream.tap((acc) =>
        Effect.sync(() => onProgress?.(estimateTokens(acc.length), SUMMARY_TOKEN_BUDGET)),
      ),
      // Stop the moment the summary reaches its token budget. Letting a slow local model overrun the
      // budget pins the progress bar at 100% for many extra seconds of wasted generation; stopping
      // here interrupts the request (the provider aborts on interrupt) so it halts at the budget.
      Stream.takeUntil((acc) => estimateTokens(acc.length) >= SUMMARY_TOKEN_BUDGET),
      // Keep the last accumulator emitted (the full summary, or the budget-capped prefix).
      Stream.runFold("", (_, acc) => acc),
      Effect.map(capSummary),
    );
  // Fire an immediate 0-token tick BEFORE the stream starts, so the progress bar appears the instant
  // summarization begins. The model can spend many seconds INGESTING a large fold prompt before its
  // first output token, and the streamed ticks only begin then - without this the bar is invisible
  // (no feedback) for the whole ingestion, which reads as a hung /compact.
  return Effect.sync(() => onProgress?.(0, SUMMARY_TOKEN_BUDGET)).pipe(Effect.zipRight(fold));
}
