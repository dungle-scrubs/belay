import {
  type CompactionManifest,
  type DecodedEvent,
  decodeTrevorEvent,
  type SessionEvent,
  events as sessionEvents,
  type TrevorEventInput,
} from "@trevor/session";
import { Effect } from "effect";
import type { ChatMessage, Provider, ProviderError } from "../providers";
import { estimateTokens } from "../usage/tokens";
import { analyzeBaseline } from "./baseline";
import { SUMMARY_TOKEN_BUDGET, summarize } from "./compaction";
import { toolCallGrouper } from "./tool-messages";

/**
 * Cross-turn compaction's TRIGGER + fold planning (D-040, D-041). Overflow recovery is the
 * within-turn airbag; this is the between-turn governor that keeps the durable history's prompt
 * projection under the window across turns. Two regimes drive the same fold:
 *   - background-after: a turn ending over COMPACT_WHEN compacts in idle time, down under COMPACT_TO;
 *   - blocking-before:  a turn must never START over COMPACT_WHEN, so if the background pass has not
 *     caught up it compacts first, blocking.
 * Both run off the host's one-turn-at-a-time gate, never concurrently with a turn. Planning is a
 * pure function (testable in isolation); `runCompaction` adds the one tool-less summary call.
 */

/** Compact WHEN the prompt crosses this fraction of the window... */
export const COMPACT_WHEN = 0.8;
/** ...folding the oldest turns until the projection is estimated back under this fraction. The gap
 *  between the two is working headroom per cycle, so compaction does not thrash. */
export const COMPACT_TO = 0.5;
/** Recent turns to keep verbatim BEYOND what fits under budget. 0 = keep only what fits, so a single
 *  oversized completed turn (e.g. a whole-codebase read that filled the window in one turn) can be
 *  folded on its own - the common case. The keep-suffix walk still keeps every recent turn that fits;
 *  this only governs the floor. The token-savings guard in planCompaction stops a pointless fold of
 *  tiny content (which would ADD the ~1k summary rather than save). */
const MIN_RECENT_TURNS = 0;

/** True when the latest prompt size crosses `fraction` of the window (window 0 = unknown → false). */
export function overBudget(input: number, window: number, fraction: number): boolean {
  return window > 0 && input >= fraction * window;
}

/** One completed turn, reconstructed into the conversation messages it contributes - user prompt,
 *  the assistant's tool-call messages + their tool RESULTS, and the final answer - the same way
 *  buildHistory carries tool activity into the prompt. `chars` is the total over all of them, so the
 *  tool results (the file reads that actually fill the window) drive the keep/fold decision and the
 *  summary that replaces them. */
interface Turn {
  readonly startSeq: number;
  readonly endSeq: number;
  readonly messages: readonly ChatMessage[];
  readonly chars: number;
}

/** A planned fold: which turns collapse, the prior rolling head to extend, and token estimates. */
export interface FoldPlan {
  readonly throughSeq: number;
  /** The NEW turns being folded into the summary (excludes already-folded + pinned goal/tasks). */
  readonly foldedTurns: readonly ChatMessage[];
  readonly priorSummary: string | null;
  readonly priorFoldId: string | null;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly manifest: CompactionManifest;
}

/** Decomposes the baseline into completed turns, reconstructing each turn's full message list -
 *  user prompt, the assistant's tool-call messages + their tool results, final answer - exactly as
 *  buildHistory carries tool activity into the prompt (so a turn's fold size matches its prompt
 *  footprint). Takes the baseline's pre-decoded events (paired by index) so the planner decodes the
 *  log once. An unanswered trailing prompt is not a turn (it stays recent, never folded). */
function decomposeTurns(
  baseline: readonly SessionEvent[],
  decodedBaseline: readonly (DecodedEvent | null)[],
  selfProducerId: string,
): Turn[] {
  const turns: Turn[] = [];
  let startSeq = -1;
  let messages: ChatMessage[] = [];
  let open = false;
  // The shared tool-call reconstruction rule (see toolCallGrouper) - the same one buildHistory uses,
  // so a turn's folded message footprint matches its real prompt footprint. emit pushes into the
  // current turn's `messages` (reassigned per turn below); a turn is always opened by a user message,
  // so the leading tool-call message is always allowed.
  const tools = toolCallGrouper((message) => messages.push(message));
  for (let i = 0; i < baseline.length; i += 1) {
    const event = baseline[i];
    const decoded = decodedBaseline[i];
    if (!event || !decoded) {
      continue;
    }
    if (decoded.type === "user.message" && event.producerId !== selfProducerId) {
      // A new prompt opens a turn (an abandoned prior one is dropped, mirroring the projection).
      startSeq = event.seq;
      messages = [{ role: "user", content: decoded.text }];
      open = true;
      tools.reset();
    } else if (decoded.type === "tool.started" && open) {
      tools.started(decoded.callId, decoded.name, decoded.arguments);
    } else if (decoded.type === "tool.completed" && open) {
      tools.completed(decoded.callId, decoded.name, decoded.result);
    } else if (decoded.type === "assistant.completed" && open) {
      if (decoded.text.trim()) {
        messages.push({ role: "assistant", content: decoded.text });
      }
      // Close the turn if it has anything beyond the bare prompt to fold (tool reads count, even on
      // a cancelled/blank-text turn). A user message with nothing after it isn't worth a turn.
      if (messages.length > 1) {
        turns.push({
          startSeq,
          endSeq: event.seq,
          messages,
          chars: messages.reduce((sum, message) => sum + message.content.length, 0),
        });
      }
      open = false;
      messages = [];
      tools.reset();
    }
  }
  return turns;
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
  if (!force && window <= 0) {
    return null; // unknown window - the step-budget path governs instead (D-053). Force ignores it.
  }
  // The baseline + its latest fold + goal pin, computed once over a single decode pass and shared
  // with the projection (analyzeBaseline), so the planner can never fold a different prefix than
  // buildHistory collapses. The latest fold covers everything through priorThroughSeq; only newer
  // turns are folded.
  const decoded = events.map((event) => decodeTrevorEvent(event));
  const { start, fold, goal } = analyzeBaseline(events, decoded, selfProducerId);
  const baseline = events.slice(start);
  const priorThroughSeq = fold?.throughSeq ?? -1;
  const priorSummary = fold?.summary ?? null;
  const priorFoldId = fold?.foldId ?? null;

  const candidates = decomposeTurns(baseline, decoded.slice(start), selfProducerId).filter(
    (t) => t.endSeq > priorThroughSeq,
  );
  if (candidates.length <= MIN_RECENT_TURNS) {
    return null; // not enough completed turns beyond the prior fold to bother folding
  }

  // Budget (tokens) for the recent verbatim turns = the target minus the pins + summary overhead.
  // The goal pin is the first user message of the baseline (re-injected outside the fold).
  const goalLen = goal?.text.length ?? 0;
  const overhead = estimateTokens(goalLen) + SUMMARY_TOKEN_BUDGET;
  // Auto: keep recent turns that fit under COMPACT_TO of the window. Force: budget 0 - fold every
  // completed turn (the user asked for it), keeping nothing verbatim beyond the pins + summary.
  const budget = force ? 0 : Math.max(0, COMPACT_TO * window - overhead);

  // Walk newest → oldest, keeping turns while they fit (always keeping >= MIN_RECENT_TURNS).
  let keptTokens = 0;
  let keepFrom = candidates.length;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const turn = candidates[i];
    if (!turn) {
      continue;
    }
    const keptCount = candidates.length - i;
    const tokens = estimateTokens(turn.chars);
    if (keptCount > MIN_RECENT_TURNS && keptTokens + tokens > budget) {
      break;
    }
    keptTokens += tokens;
    keepFrom = i;
  }

  const folded = candidates.slice(0, keepFrom);
  if (folded.length === 0) {
    return null; // everything recent already fits - nothing to fold
  }
  const lastFolded = folded[folded.length - 1];
  const firstFolded = folded[0];
  if (!lastFolded || !firstFolded) {
    return null;
  }
  const foldedChars = folded.reduce((sum, turn) => sum + turn.chars, 0);
  // Don't fold content smaller than the summary that would replace it - a tiny fold would ADD the
  // ~1k-token summary rather than save tokens. With MIN_RECENT_TURNS=0 this also stops a pointless
  // single-tiny-turn fold (e.g. a one-line exchange).
  if (estimateTokens(foldedChars) <= SUMMARY_TOKEN_BUDGET) {
    return null;
  }
  const priorSummaryChars = priorSummary?.length ?? 0;
  const keptChars = candidates.slice(keepFrom).reduce((sum, turn) => sum + turn.chars, 0);
  // Estimate the post-fold size from the projection ITSELF, not by subtracting the folded estimate
  // from tokensBefore: those are measured differently (provider tokenizer vs char/4) and tokensBefore
  // can be stale, so the subtraction could go negative and clamp to a nonsensical ~0. Instead derive
  // the fixed overhead (system prompt + tool schemas) as the measured prompt minus the conversation
  // content, then rebuild: overhead + the kept verbatim turns + the re-injected goal pin + the new
  // ~1k summary. Always >= goal + summary, never ~0. Corrected by the next turn's real measurement.
  const overheadTokens = Math.max(
    0,
    tokensBefore - estimateTokens(foldedChars + keptChars + priorSummaryChars),
  );
  const tokensAfter = overheadTokens + estimateTokens(keptChars + goalLen) + SUMMARY_TOKEN_BUDGET;

  return {
    throughSeq: lastFolded.endSeq,
    foldedTurns: folded.flatMap((turn) => turn.messages),
    priorSummary,
    priorFoldId,
    tokensBefore,
    tokensAfter,
    // Per-fold delta manifest. turnRange is exact; files/tools/topics are reserved for session
    // recall (D-044) and left empty for v1 - the structure ships now, enrichment lands later.
    manifest: {
      turnRange: { fromSeq: firstFolded.startSeq, toSeq: lastFolded.endSeq },
      files: [],
      tools: [],
      topics: [],
    },
  };
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
