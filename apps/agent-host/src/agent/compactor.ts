import { type SessionEvent, events as sessionEvents, type TrevorEventInput } from "@trevor/session";
import { Effect } from "effect";
import type { ChatMessage, Provider, ProviderError } from "../providers";
import { CHARS_PER_TOKEN } from "../usage/breakdown";
import { CompactionPlanner, type FoldPlan, SUMMARY_TOKEN_BUDGET } from "./compaction-planner";
import { distillToBudget } from "./tool-less-summary";

export { COMPACT_TO, COMPACT_WHEN, SUMMARY_TOKEN_BUDGET } from "./compaction-planner";

/**
 * Owns history FOLDING for cross-turn compaction (D-040..D-043), end to end: the optional trigger
 * (overBudget), the pure fold PLANNING (planCompaction), and the tool-less SUMMARIZATION
 * (summarize) - producing the `context.compacted` event the host publishes.
 *
 * Overflow recovery is the within-turn airbag; this is the between-turn governor that keeps the
 * durable history's prompt projection under the window across turns. Two regimes drive the same
 * fold:
 *   - background-after: a turn ending over COMPACT_WHEN compacts in idle time, down under COMPACT_TO;
 *   - blocking-before:  a turn must never START over COMPACT_WHEN, so if the background pass has not
 *     caught up it compacts first, blocking.
 * Both run off the host's one-turn-at-a-time gate, never concurrently with a turn. Planning is a
 * pure function (testable in isolation); `runCompaction` threads the plan into the one tool-less
 * summary call, never exposing the intermediate plan to callers.
 *
 * The provider is the routing SEAM: the caller passes the turn's provider for now; per-fold
 * local↔cloud routing (D-046) reuses this entry point later without changing the call sites.
 */

/** Hard cap on the summary length (chars), independent of whether the model respected the budget. */
const SUMMARY_CHAR_CAP = SUMMARY_TOKEN_BUDGET * CHARS_PER_TOKEN;

/** True when the latest prompt size crosses `fraction` of the window (window 0 = unknown → false). */
export function overBudget(input: number, window: number, fraction: number): boolean {
  return window > 0 && input >= fraction * window;
}

/**
 * Plans the fold. Auto path: keep the largest suffix of recent turns that still fits under
 * COMPACT_TO of the window (more verbatim context is better), fold the rest. `force` path (manual
 * /compact): the user asked, so fold EVERY completed turn regardless of the window - budget 0, no
 * window requirement - down to just the pins + summary. Returns null when there is nothing worth
 * folding (no turns, or the foldable content is smaller than the summary that would replace it).
 * Pure - no model call, no IO.
 */
export function planCompaction(
  events: readonly SessionEvent[],
  window: number,
  selfProducerId: string,
  tokensBefore: number,
  force = false,
): FoldPlan | null {
  return CompactionPlanner.plan(events, window, selfProducerId, tokensBefore, force);
}

/**
 * Plans and runs one compaction: the pure fold plan plus the single tool-less summary call,
 * yielding the `context.compacted` event to publish - or null when there is nothing to fold. The
 * caller publishes + admits it (so the projection updates) off the one-turn gate. `foldId` is
 * supplied by the caller (a fresh id) to keep this independent of any clock/RNG.
 */
export function runCompaction(
  provider: Provider,
  events: readonly SessionEvent[],
  window: number,
  selfProducerId: string,
  tokensBefore: number,
  foldId: string,
  onProgress?: (tokens: number, budget: number) => void,
  force = false,
): Effect.Effect<TrevorEventInput | null, ProviderError> {
  const plan = planCompaction(events, window, selfProducerId, tokensBefore, force);
  if (!plan) {
    return Effect.succeed(null);
  }
  return summarize(
    provider,
    {
      priorSummary: plan.priorSummary,
      foldedTurns: plan.foldedTurns,
    },
    onProgress,
  ).pipe(
    Effect.map((summary) =>
      sessionEvents.contextCompacted({
        foldId,
        throughSeq: plan.throughSeq,
        ...(plan.priorFoldId ? { supersedes: plan.priorFoldId } : {}),
        summary,
        manifest: plan.manifest,
        tokensBefore: plan.tokensBefore,
        tokensAfter: plan.tokensAfter,
        model: provider.model,
      }),
    ),
  );
}

// --- summarization (D-043): the tool-less rolling-summary generator ---
//
// A tool-less model call that folds the prior rolling summary plus a run of older turns into the
// next rolling summary. The summary rides in every later prompt (history-projection.ts injects it
// as the fold's synthetic assistant message), so it must stay small - the model is asked to
// re-summarize to a fixed budget as more folds in, never to grow it, and a hard char cap backstops
// the model not honoring that.

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
  return distillToBudget(provider, buildSummaryPrompt(input), {
    tokenBudget: SUMMARY_TOKEN_BUDGET,
    charCap: SUMMARY_CHAR_CAP,
    ...(onProgress ? { onProgress } : {}),
  });
}
