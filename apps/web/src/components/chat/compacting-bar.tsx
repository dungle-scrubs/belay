import { Layers } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { compactionActionLabel } from "@/action-label";
import { fmtTokens } from "../../derive";

/**
 * The live cross-turn compaction bar (D-040): a TRANSIENT indicator that vanishes when the fold
 * completes. The fill is driven by requestAnimationFrame straight to the DOM (no per-frame React
 * re-render), so it moves CONTINUOUSLY rather than snapping between the host's discrete ticks:
 *   - It starts at 0 and always advances - a slow "still working" TRICKLE eases toward a ceiling, so
 *     even during the long prompt-ingestion phase (no real progress yet) the bar keeps creeping
 *     forward and decelerating, never sitting parked at a fixed %.
 *   - When the summary actually streams, the real token-based % overtakes the trickle and the fill
 *     eases toward it - decelerating as it nears each tick and lagging just behind, so it glides
 *     instead of jumping. It is monotonic (never moves backward) and can ease all the way to 100%.
 */
export function CompactingBar({ tokens, budget }: { tokens: number; budget: number }) {
  const preparing = tokens === 0;
  const realPct = Math.min(100, (tokens / Math.max(1, budget)) * 100);
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  const barRef = useRef<HTMLDivElement>(null);

  // Start collapsed before first paint, so the bar never flashes wide before rAF takes over.
  useLayoutEffect(() => {
    if (barRef.current) {
      barRef.current.style.width = "0%";
    }
  }, []);

  useEffect(() => {
    let raf = 0;
    let shown = 0; // displayed %, monotonic
    let trickle = 0; // the "still working" floor that always creeps up while there's no real signal
    let last = 0;
    const frame = (t: number) => {
      const dt = last ? Math.min(80, t - last) : 16;
      last = t;
      // Frame-rate-independent exponential approaches (1 - e^(-dt/τ)). The trickle creeps toward a
      // modest ceiling over a long time constant. The fill eases toward its target over a deliberately
      // SLOW time constant (~1.6s), so it decelerates and always lags well behind the target - a slow
      // descent that never quite reaches each tick before the next one nudges the target onward.
      trickle += (58 - trickle) * (1 - Math.exp(-dt / 28000));
      const rp = Math.min(100, (tokensRef.current / Math.max(1, budgetRef.current)) * 100);
      const target = Math.max(shown, trickle, rp); // monotonic: never recede
      shown += (target - shown) * (1 - Math.exp(-dt / 1600));
      if (barRef.current) {
        barRef.current.style.width = `${shown}%`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="pl-3.5">
      <div className="flex flex-col gap-1.5 rounded border border-smui-frost-3/25 bg-smui-frost-3/[0.04] px-3 py-2">
        <div className="flex items-center justify-between text-label tracking-wider text-smui-frost-3">
          <span className="inline-flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5 animate-pulse" />
            {compactionActionLabel()}…
          </span>
          <span>{preparing ? "preparing…" : `${Math.round(realPct)}%`}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-smui-surface-1">
          <div className="h-full rounded-full bg-smui-frost-3" ref={barRef} />
        </div>
        <span className="text-label tracking-wider text-muted-foreground/70">
          {preparing
            ? "reading the context to summarize…"
            : `${fmtTokens(tokens)} / ~${fmtTokens(budget)} tok summarized`}
        </span>
      </div>
    </div>
  );
}
