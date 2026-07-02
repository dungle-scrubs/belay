/**
 * Responsible for: pure compaction fold planning - decomposing the baseline into turns and
 * choosing the folded prefix + token estimates (COMPACT_WHEN / COMPACT_TO live here).
 * Not for: the summarization model call and the context.compacted event - compactor.ts.
 */
import { estimateTokens } from "@host/metrics/breakdown";
import {
  type CompactionManifest,
  type DecodedEvent,
  decodeTrevorEvent,
  type SessionEvent,
} from "@trevor/session";
import type { ChatMessage } from "../providers";
import { analyzeBaseline } from "./baseline";
import { toolCallGrouper } from "./tool-messages";

/** Compact WHEN the prompt crosses this fraction of the window... */
export const COMPACT_WHEN = 0.8;
/** ...folding the oldest turns until the projection is estimated back under this fraction. */
export const COMPACT_TO = 0.5;
const MIN_RECENT_TURNS = 0;
export const SUMMARY_TOKEN_BUDGET = 1_000;

interface Turn {
  readonly startSeq: number;
  readonly endSeq: number;
  readonly messages: readonly ChatMessage[];
  readonly chars: number;
}

export interface AnalyzedLog {
  readonly decoded: readonly (DecodedEvent | null)[];
  readonly baselineStart: number;
  readonly baseline: readonly SessionEvent[];
  readonly fold: ReturnType<typeof analyzeBaseline>["fold"];
  readonly goal: ReturnType<typeof analyzeBaseline>["goal"];
  readonly tasks: ReturnType<typeof analyzeBaseline>["tasks"];
}

export interface FoldPlan {
  readonly throughSeq: number;
  readonly foldedTurns: readonly ChatMessage[];
  readonly priorSummary: string | null;
  readonly priorFoldId: string | null;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly manifest: CompactionManifest;
}

function analyzeLog(
  events: readonly SessionEvent[],
  selfProducerId: string | undefined,
): AnalyzedLog {
  const decoded = events.map((event) => decodeTrevorEvent(event));
  const { start, fold, goal, tasks } = analyzeBaseline(events, decoded, selfProducerId);
  return {
    decoded,
    baselineStart: start,
    baseline: events.slice(start),
    fold,
    goal,
    tasks,
  };
}

function decomposeTurns(
  baseline: readonly SessionEvent[],
  decodedBaseline: readonly (DecodedEvent | null)[],
  selfProducerId: string | undefined,
): Turn[] {
  const turns: Turn[] = [];
  let startSeq = -1;
  let messages: ChatMessage[] = [];
  let open = false;
  const tools = toolCallGrouper((message) => messages.push(message));
  for (let i = 0; i < baseline.length; i += 1) {
    const event = baseline[i];
    const decoded = decodedBaseline[i];
    if (!event || !decoded) {
      continue;
    }
    if (decoded.type === "user.message" && event.producerId !== selfProducerId) {
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

function planFromAnalysis(
  analysis: AnalyzedLog,
  window: number,
  selfProducerId: string | undefined,
  tokensBefore: number,
  force: boolean,
): FoldPlan | null {
  if (!force && window <= 0) {
    return null;
  }
  const priorThroughSeq = analysis.fold?.throughSeq ?? -1;
  const priorSummary = analysis.fold?.summary ?? null;
  const priorFoldId = analysis.fold?.foldId ?? null;
  const candidates = decomposeTurns(
    analysis.baseline,
    analysis.decoded.slice(analysis.baselineStart),
    selfProducerId,
  ).filter((t) => t.endSeq > priorThroughSeq);
  if (candidates.length <= MIN_RECENT_TURNS) {
    return null;
  }

  const goalLen = analysis.goal?.text.length ?? 0;
  const overhead = estimateTokens(goalLen) + SUMMARY_TOKEN_BUDGET;
  const budget = force ? 0 : Math.max(0, COMPACT_TO * window - overhead);

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
    return null;
  }
  const lastFolded = folded[folded.length - 1];
  const firstFolded = folded[0];
  if (!lastFolded || !firstFolded) {
    return null;
  }
  const foldedChars = folded.reduce((sum, turn) => sum + turn.chars, 0);
  if (estimateTokens(foldedChars) <= SUMMARY_TOKEN_BUDGET) {
    return null;
  }
  const priorSummaryChars = priorSummary?.length ?? 0;
  const keptChars = candidates.slice(keepFrom).reduce((sum, turn) => sum + turn.chars, 0);
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
    manifest: {
      turnRange: { fromSeq: firstFolded.startSeq, toSeq: lastFolded.endSeq },
      files: [],
      tools: [],
      topics: [],
    },
  };
}

export const CompactionPlanner = {
  analyze(events: readonly SessionEvent[], selfProducerId?: string): AnalyzedLog {
    return analyzeLog(events, selfProducerId);
  },
  plan(
    events: readonly SessionEvent[],
    window: number,
    selfProducerId: string,
    tokensBefore: number,
    force = false,
  ): FoldPlan | null {
    return planFromAnalysis(
      analyzeLog(events, selfProducerId),
      window,
      selfProducerId,
      tokensBefore,
      force,
    );
  },
};
