/**
 * Responsible for: the ONE pinned live turn-status line (plan 50) shown above the task checklist for
 * the in-flight turn - a semantic action `headline` followed by a muted parenthetical of live metrics
 * `(<elapsed> · ↓ <output> tokens · <state>)`, e.g. `Adding schemas and tests… (2m 37s · ↓ 2.6k tokens
 * · thinking)`. It owns the LINE CONTRACT (D-002/D-003): the `·` middot join, the `↓` output-token
 * glyph, the HIDDEN-token-cell rule (the `↓` cell is absent until the first `assistant.progress` gives
 * an output count), and the REDUNDANCY rule (the trailing engine `state` cell is dropped when it
 * already equals the headline, so `thinking (…)` never reads `thinking (… · thinking)`). Elapsed ticks
 * once per second via the shared `useElapsedLabel`.
 *
 * Not for: deciding WHAT the headline/state/token values are - that is the `turnStatusHeaderFrom`
 * projection in `derive.ts`; this component only renders whatever typed props it is handed. Not the
 * home of the `esc to interrupt` affordance either - that hint lives in the pinned mount region beside
 * this line, never inside the parenthetical (D-003). Presentational: props in, one line out. Inherits
 * `ShimmerText`'s a11y (an announced solid base span + an `aria-hidden`, `motion-reduce:animate-none`
 * overlay), so the label announces exactly once and stops animating under reduced motion.
 */

import { fmtTokens } from "@/derive";
import { useElapsedLabel } from "@/hooks/use-elapsed-label";
import { cn } from "@/lib/utils";
import { ShimmerText } from "./action-shimmer";

/** The `↓ <count> tokens` output cell: `↓` marks tokens STREAMED DOWN, abbreviated via `fmtTokens`. */
export function formatOutputTokenCell(outputTokens: number): string {
  return `↓ ${fmtTokens(outputTokens)} tokens`;
}

export function TurnStatusHeader({
  headline,
  startedAt,
  outputTokens,
  state,
  className,
}: {
  readonly headline: string;
  readonly startedAt?: number;
  readonly outputTokens?: number;
  readonly state?: string;
  readonly className?: string;
}) {
  const elapsed = useElapsedLabel(startedAt);
  const cells = [
    elapsed,
    // Hidden-token-cell rule (D-002): no `↓` cell until the first progress snapshot supplies a count.
    outputTokens === undefined ? null : formatOutputTokenCell(outputTokens),
    // Redundancy rule (D-003): the engine state is dropped when the headline already IS that state,
    // so a no-task turn reads `thinking (2m 37s)` rather than `thinking (2m 37s · thinking)`.
    state && state !== headline ? state : null,
  ].filter((cell): cell is string => Boolean(cell));

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm text-foreground", className)}>
      <span className="font-semibold">
        <ShimmerText>{headline}</ShimmerText>
      </span>
      {cells.length > 0 ? (
        <span className="text-muted-foreground">({cells.join(" · ")})</span>
      ) : null}
    </span>
  );
}
