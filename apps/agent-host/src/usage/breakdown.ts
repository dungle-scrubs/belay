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
 */

const CHARS_PER_TOKEN = 4;
const estTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);
const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

interface InputCats {
  systemAndTools: number;
  userText: number;
  assistantText: number;
  toolCallArgs: number;
  toolResults: number;
  imagesBase64: number;
  imageCount: number;
  /** Tool result chars keyed by tool name - which tool is eating the context. */
  byTool: Record<string, number>;
}

interface OutputCats {
  thinking: number;
  answer: number;
  toolCallArgs: number;
}

export interface UsageBreakdown {
  readonly input: InputCats;
  readonly output: OutputCats;
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

  snapshot(): UsageBreakdown {
    return {
      input: { ...this.input, byTool: { ...this.input.byTool } },
      output: { ...this.output },
    };
  }
}

/** Total of the text-bearing input categories (images excluded - see header). */
const inputTextChars = (b: UsageBreakdown): number =>
  b.input.systemAndTools +
  b.input.userText +
  b.input.assistantText +
  b.input.toolCallArgs +
  b.input.toolResults;

const outputChars = (b: UsageBreakdown): number =>
  b.output.thinking + b.output.answer + b.output.toolCallArgs;

const topTools = (byTool: Record<string, number>, n = 3): string => {
  const entries = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "none";
  return entries
    .slice(0, n)
    .map(([name, chars]) => `${name}:${estTokens(chars)}`)
    .join(",");
};

/** Running session totals so the per-turn line can also report an across-turns average. */
const session = {
  turns: 0,
  in: { systemAndTools: 0, userText: 0, assistantText: 0, toolCallArgs: 0, toolResults: 0 },
  out: { thinking: 0, answer: 0, toolCallArgs: 0 },
};

/**
 * Logs one turn's breakdown on the `usage` scope, then a rolling session average.
 * Greppable as `usage: breakdown` / `usage: session-avg`.
 */
export function logUsageBreakdown(
  runId: string,
  b: UsageBreakdown,
  usage: Usage | undefined,
): void {
  const inText = inputTextChars(b);
  const outTotal = outputChars(b);

  log("usage", "breakdown", {
    runId,
    ctxUsed: usage?.input,
    ctxWindow: usage?.contextWindow,
    ctxPct: usage ? pct(usage.input, usage.contextWindow) : undefined,
    outActual: usage?.output,
    inEstTokens: estTokens(inText),
    inToolResults: pct(b.input.toolResults, inText),
    inSysTools: pct(b.input.systemAndTools, inText),
    inUserText: pct(b.input.userText, inText),
    inAssistant: pct(b.input.assistantText, inText),
    inToolArgs: pct(b.input.toolCallArgs, inText),
    images: b.input.imageCount,
    imagesB64Kb: Math.round(b.input.imagesBase64 / 1024),
    outEstTokens: estTokens(outTotal),
    outThinking: pct(b.output.thinking, outTotal),
    outAnswer: pct(b.output.answer, outTotal),
    outArgs: pct(b.output.toolCallArgs, outTotal),
    topTools: topTools(b.input.byTool),
  });

  session.turns += 1;
  session.in.systemAndTools += b.input.systemAndTools;
  session.in.userText += b.input.userText;
  session.in.assistantText += b.input.assistantText;
  session.in.toolCallArgs += b.input.toolCallArgs;
  session.in.toolResults += b.input.toolResults;
  session.out.thinking += b.output.thinking;
  session.out.answer += b.output.answer;
  session.out.toolCallArgs += b.output.toolCallArgs;

  const sIn =
    session.in.systemAndTools +
    session.in.userText +
    session.in.assistantText +
    session.in.toolCallArgs +
    session.in.toolResults;
  const sOut = session.out.thinking + session.out.answer + session.out.toolCallArgs;

  log("usage", "session-avg", {
    turns: session.turns,
    inToolResults: pct(session.in.toolResults, sIn),
    inSysTools: pct(session.in.systemAndTools, sIn),
    inUserText: pct(session.in.userText, sIn),
    inAssistant: pct(session.in.assistantText, sIn),
    inToolArgs: pct(session.in.toolCallArgs, sIn),
    outThinking: pct(session.out.thinking, sOut),
    outAnswer: pct(session.out.answer, sOut),
    outArgs: pct(session.out.toolCallArgs, sOut),
  });
}
