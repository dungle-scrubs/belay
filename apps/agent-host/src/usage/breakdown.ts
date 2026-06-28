import { BREAKDOWN_CATEGORIES, type BreakdownPool, type UsageBreakdown } from "@trevor/session";
import { log } from "../log";
import type { ChatMessage, Usage } from "../providers";

/**
 * Per-turn token-source breakdown - "where does the context go?" Sizes are
 * character counts taken from the conversation array plus the turn's streamed
 * events; `estTokens = chars / 4` is a deliberately rough proxy, while the
 * provider's reported `input`/`output` (logged alongside) are the ground-truth
 * totals. The two pools are kept separate on purpose:
 *
 *   - input  = what fills the prompt and persists across steps (system+tools,
 *              user text, prior assistant text, tool-call args, tool RESULTS).
 *              This is the pool that overflows; tool results usually dominate.
 *   - output = what the model generates this turn and is NOT retained
 *              (thinking, answer, tool-call args). Thinking lives only here.
 *
 * Images are tracked apart from the text categories because a vision model's
 * token cost is not proportional to base64 length, so folding base64 chars into
 * the text shares would badly distort them.
 *
 * The category set itself (keys, pools, overhead grouping) is the shared
 * `BREAKDOWN_CATEGORIES` descriptor in @trevor/session; the wire `UsageBreakdown`,
 * this accumulator's totals/session-roll-up, and the web treemap all derive from it,
 * so adding a category is one edit and the surfaces cannot drift.
 */

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

/**
 * The single char -> token heuristic for host-side estimates. Real token counts come from reported
 * provider usage; this is the deliberately rough proxy used only where no measurement exists:
 * usage breakdown display, compaction summaries, and recall distillation budgets.
 */
export const CHARS_PER_TOKEN = 4;

/** Estimates tokens from a character count via the shared ~4 chars/token heuristic. */
export const estimateTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

/** The accumulator's internal mutable shape (the wire `UsageBreakdown` is readonly). */
interface InputCats {
  systemAndTools: number;
  userText: number;
  assistantText: number;
  toolCallArgs: number;
  toolResults: number;
  imagesBase64: number;
  imageCount: number;
  byTool: Record<string, number>;
}

interface OutputCats {
  thinking: number;
  answer: number;
  toolCallArgs: number;
}

/**
 * Accumulates one turn's breakdown: seed the input pool from the conversation at
 * turn start, then fold in the turn's tool calls, tool results, answer, and
 * thinking as their AgentEvents stream through.
 */
export class BreakdownAccumulator {
  private readonly input: InputCats;
  private readonly output: OutputCats = { thinking: 0, answer: 0, toolCallArgs: 0 };

  constructor(systemAndToolsChars: number) {
    this.input = {
      systemAndTools: systemAndToolsChars,
      userText: 0,
      assistantText: 0,
      toolCallArgs: 0,
      toolResults: 0,
      imagesBase64: 0,
      imageCount: 0,
      byTool: {},
    };
  }

  /** Seed input categories from the conversation present at turn start. */
  seedHistory(history: readonly ChatMessage[]): void {
    for (const m of history) {
      if (m.role === "user") {
        this.input.userText += m.content.length;
        for (const img of m.images ?? []) {
          this.input.imageCount += 1;
          this.input.imagesBase64 += img.data.length;
        }
      } else if (m.role === "assistant") {
        this.input.assistantText += m.content.length;
        for (const call of m.toolCalls ?? []) this.input.toolCallArgs += call.arguments.length;
      } else {
        this.input.toolResults += m.content.length;
        this.addTool(m.name ?? "unknown", m.content.length);
      }
    }
  }

  /** A tool call the model requested this turn: generated output, and context for the next step. */
  onToolCall(argsChars: number): void {
    this.input.toolCallArgs += argsChars;
    this.output.toolCallArgs += argsChars;
  }

  /** A tool result fed back into the conversation this turn. */
  onToolResult(name: string, chars: number): void {
    this.input.toolResults += chars;
    this.addTool(name, chars);
  }

  onAnswer(chars: number): void {
    this.output.answer += chars;
  }

  onThinking(chars: number): void {
    this.output.thinking += chars;
  }

  private addTool(name: string, chars: number): void {
    this.input.byTool[name] = (this.input.byTool[name] ?? 0) + chars;
  }

  /**
   * Total chars across one pool's descriptor categories (images/byTool excluded - not categories).
   * This is the accumulator's home for the category schema: callers ask for a pool total instead of
   * reading `snapshot()` and hand-summing by iterating BREAKDOWN_CATEGORIES, so a new category folds
   * into the total here without re-opening every caller. `snapshot()` stays the wire envelope only.
   */
  poolTotal(pool: BreakdownPool): number {
    const counts = (pool === "input" ? this.input : this.output) as unknown as Record<
      string,
      number
    >;
    let total = 0;
    for (const c of BREAKDOWN_CATEGORIES) {
      if (c.pool === pool) {
        total += counts[c.key] ?? 0;
      }
    }
    return total;
  }

  snapshot(): UsageBreakdown {
    return {
      input: { ...this.input, byTool: { ...this.input.byTool } },
      output: { ...this.output },
    };
  }
}

/** Reads a pool's category counts as a plain number map. byTool/images are not
 *  descriptor categories, so iterating BREAKDOWN_CATEGORIES never reads them. */
const poolCounts = (b: UsageBreakdown, pool: BreakdownPool): Record<string, number> =>
  b[pool] as unknown as Record<string, number>;

/** A category count, defaulting to 0 (every descriptor key is present, so this only
 *  satisfies noUncheckedIndexedAccess on the string index). */
const at = (counts: Record<string, number>, key: string): number => counts[key] ?? 0;

const topTools = (byTool: Readonly<Record<string, number>>, n = 3): string => {
  const entries = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "none";
  return entries
    .slice(0, n)
    .map(([name, chars]) => `${name}:${estimateTokens(chars)}`)
    .join(",");
};

/** A fresh per-category totals map for one pool, zeroed from the descriptor. */
const zeroPool = (pool: BreakdownPool): Record<string, number> =>
  Object.fromEntries(BREAKDOWN_CATEGORIES.filter((c) => c.pool === pool).map((c) => [c.key, 0]));

/** Running session totals (per category) so the per-turn line can also report an
 *  across-turns average. Keyed by category; both init and accumulation iterate the
 *  descriptor, so a new category rolls in without touching this. */
const session = {
  turns: 0,
  in: zeroPool("input"),
  out: zeroPool("output"),
};

const sumValues = (r: Record<string, number>): number =>
  Object.values(r).reduce((a, b) => a + b, 0);

/**
 * Logs one turn's breakdown on the `usage` scope, then a rolling session average.
 * Greppable as `usage: breakdown` / `usage: session-avg`. Takes the accumulator (not a raw
 * snapshot) so the pool totals come from its category-driven `poolTotal` accessor rather than this
 * caller re-summing the schema; the per-category percentages still read the snapshot's fields.
 */
export function logUsageBreakdown(
  runId: string,
  breakdown: BreakdownAccumulator,
  usage: Usage | undefined,
): void {
  const b = breakdown.snapshot();
  const inText = breakdown.poolTotal("input");
  const outTotal = breakdown.poolTotal("output");

  log("usage", "breakdown", {
    runId,
    ctxUsed: usage?.input,
    ctxWindow: usage?.contextWindow,
    ctxPct: usage ? pct(usage.input, usage.contextWindow) : undefined,
    outActual: usage?.output,
    inEstTokens: estimateTokens(inText),
    inToolResults: pct(b.input.toolResults, inText),
    inSysTools: pct(b.input.systemAndTools, inText),
    inUserText: pct(b.input.userText, inText),
    inAssistant: pct(b.input.assistantText, inText),
    inToolArgs: pct(b.input.toolCallArgs, inText),
    images: b.input.imageCount,
    imagesB64Kb: Math.round(b.input.imagesBase64 / 1024),
    outEstTokens: estimateTokens(outTotal),
    outThinking: pct(b.output.thinking, outTotal),
    outAnswer: pct(b.output.answer, outTotal),
    outArgs: pct(b.output.toolCallArgs, outTotal),
    topTools: topTools(b.input.byTool),
  });

  session.turns += 1;
  for (const c of BREAKDOWN_CATEGORIES) {
    const dst = c.pool === "input" ? session.in : session.out;
    dst[c.key] = at(dst, c.key) + at(poolCounts(b, c.pool), c.key);
  }

  const sIn = sumValues(session.in);
  const sOut = sumValues(session.out);

  log("usage", "session-avg", {
    turns: session.turns,
    inToolResults: pct(at(session.in, "toolResults"), sIn),
    inSysTools: pct(at(session.in, "systemAndTools"), sIn),
    inUserText: pct(at(session.in, "userText"), sIn),
    inAssistant: pct(at(session.in, "assistantText"), sIn),
    inToolArgs: pct(at(session.in, "toolCallArgs"), sIn),
    outThinking: pct(at(session.out, "thinking"), sOut),
    outAnswer: pct(at(session.out, "answer"), sOut),
    outArgs: pct(at(session.out, "toolCallArgs"), sOut),
  });
}
