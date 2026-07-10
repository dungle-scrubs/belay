import { useInterval } from "ahooks";
import { useEffect, useState } from "react";

/** The shared cadence for "Xm ago"-style relative-time labels: the same 4s the retired App-altitude
 *  clock ticked at, so every surface's recency text keeps updating on the cadence it always had. */
export const RELATIVE_TIME_TICK_MS = 4000;

export interface UseNowOptions {
  /** Whether the clock ticks at all. Disabled, the interval is not scheduled (ahooks pauses on an
   *  undefined delay) and the last sample is held. Defaults to true. */
  readonly enabled?: boolean;
}

/**
 * A leaf wall clock (Tier 2.3): the current epoch ms, re-sampled every `intervalMs` while `enabled`.
 * Surfaces that render relative-time text own their OWN clock through this hook, so a tick re-renders
 * only that leaf - not the composition root the old App-altitude `now` state re-rendered wholesale.
 * On (re-)enable the clock is re-sampled immediately, so a surface whose clock was off (or that passes
 * a deterministic `nowMs` in stories/tests and later drops it) never renders against a stale sample
 * while waiting out the first interval.
 */
export function useNow(intervalMs: number, options: UseNowOptions = {}): number {
  const enabled = options.enabled ?? true;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (enabled) {
      setNow(Date.now());
    }
  }, [enabled]);
  useInterval(() => setNow(Date.now()), enabled ? intervalMs : undefined);
  return now;
}
