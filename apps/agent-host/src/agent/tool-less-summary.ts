import { estimateTokens } from "@host/metrics/breakdown";
import { Effect, Stream } from "effect";
import type { ChatMessage, Provider, ProviderError } from "../providers";
import { cheapestReasoning } from "./reasoning-levels";

/**
 * The shared tool-less "summarize given text to a budget" pass behind both the compaction summarizer
 * (D-043) and the recall distiller (D-044 M3). One tool-less model step over a fixed prompt, reasoning
 * forced to the cheapest level (these are mechanical extraction passes, not open thinking), accumulating
 * the streamed text and STOPPING the instant it reaches `tokenBudget` - letting a slow local model overrun
 * the budget only wastes generation - then a hard char backstop in case the model ignored the budget.
 *
 * `onProgress` is advisory (a no-op when omitted): it fires an immediate 0-token tick BEFORE the stream
 * (so a live bar appears the instant the pass begins, even while the model ingests a large prompt before
 * its first output token), then once per streamed chunk with the tokens produced so far and the budget.
 */
export interface DistillOptions {
  readonly tokenBudget: number;
  readonly charCap: number;
  readonly onProgress?: (tokens: number, budget: number) => void;
}

export function distillToBudget(
  provider: Provider,
  prompt: readonly ChatMessage[],
  options: DistillOptions,
): Effect.Effect<string, ProviderError> {
  const { tokenBudget, charCap, onProgress } = options;
  const fold = provider.stream([...prompt], [], cheapestReasoning(provider.reasoningLevels)).pipe(
    Stream.mapAccum("", (acc, event) => {
      const next = event.type === "text" ? acc + event.text : acc;
      return [next, next];
    }),
    Stream.tap((acc) => Effect.sync(() => onProgress?.(estimateTokens(acc.length), tokenBudget))),
    Stream.takeUntil((acc) => estimateTokens(acc.length) >= tokenBudget),
    Stream.runFold("", (_, acc) => acc),
    Effect.map((raw) => {
      const trimmed = raw.trim();
      return trimmed.length > charCap ? trimmed.slice(0, charCap) : trimmed;
    }),
  );
  return Effect.sync(() => onProgress?.(0, tokenBudget)).pipe(Effect.zipRight(fold));
}
