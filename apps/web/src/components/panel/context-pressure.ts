import { fmtCtx, fmtTokens } from "../../derive";

/**
 * How close the latest call is to its context window, expressed as a semantic band. The
 * bands escalate as usage approaches the window so the side-panel meter can carry pressure
 * through color alone, quietly, until it actually matters (D-001).
 */
export type PressureBand = "normal" | "warning" | "danger" | "critical";

export interface ContextPressure {
  /** Raw usage ratio `ctxUsed / ctxMax`. May exceed 1 when the call overflowed the window. */
  readonly ratio: number;
  /** Rounded percent for the label; UNCLAMPED, so an overflow reads honestly as e.g. `104%`. */
  readonly percent: number;
  /** Percent clamped to `0..100` for the bar width, so the fill never spills past the track. */
  readonly clampedPercent: number;
  /** The semantic pressure band the ratio falls in. */
  readonly band: PressureBand;
  /** Compact "tokens (percent)" label, e.g. `53.8k (42%)`. */
  readonly usageLabel: string;
  /** Compact context-window label, e.g. `1M`. */
  readonly windowLabel: string;
  /** Full description carrying tokens, window, percent, and band - for `aria-label`/`title`,
   *  so assistive tech and hover get the state without relying on color. */
  readonly ariaLabel: string;
}

// Band cut-points as ratios (D-001). Compared against the raw ratio - never the rounded
// percent - so a value's band is decided by true usage, not display rounding.
const WARNING_AT = 0.7;
const DANGER_AT = 0.85;
const CRITICAL_AT = 0.95;

function bandFor(ratio: number): PressureBand {
  if (ratio >= CRITICAL_AT) {
    return "critical";
  }
  if (ratio >= DANGER_AT) {
    return "danger";
  }
  if (ratio >= WARNING_AT) {
    return "warning";
  }
  return "normal";
}

/**
 * Maps the latest call's token usage to a context-pressure state (D-001/D-002), or `null`
 * when usage cannot be derived (missing, non-finite, negative, or a non-positive window) -
 * the meter renders nothing in that case rather than guessing a ratio. Pure and React-free
 * so the threshold policy unit-tests on its own.
 */
export function contextPressureState(
  ctxUsed: number | undefined,
  ctxMax: number | undefined,
): ContextPressure | null {
  if (
    ctxUsed == null ||
    ctxMax == null ||
    !Number.isFinite(ctxUsed) ||
    !Number.isFinite(ctxMax) ||
    ctxMax <= 0 ||
    ctxUsed < 0
  ) {
    return null;
  }

  const ratio = ctxUsed / ctxMax;
  const percent = Math.round(ratio * 100);
  const clampedPercent = Math.min(100, Math.max(0, percent));
  const band = bandFor(ratio);
  const windowLabel = fmtCtx(ctxMax);

  return {
    ratio,
    percent,
    clampedPercent,
    band,
    usageLabel: `${fmtTokens(ctxUsed)} (${percent}%)`,
    windowLabel,
    ariaLabel: `Context usage ${fmtTokens(ctxUsed)} of ${windowLabel}, ${percent}%, ${band}`,
  };
}
