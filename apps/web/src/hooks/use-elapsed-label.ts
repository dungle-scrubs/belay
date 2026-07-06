import { useInterval } from "ahooks";
import { useState } from "react";
import { formatElapsed } from "@/derive";

/**
 * Live elapsed since `startedAt` (ms epoch), re-rendered each second; null when no start time.
 *
 * The single owner of the "tick a human elapsed label once per second" behavior, shared by the
 * `ActionShimmer` turn form, the pinned `TurnStatusHeader` (plan 50), and the inline-agent row
 * (plan 09.4) so none hand-rolls its own timer. An undefined `startedAt` PAUSES the interval (ahooks
 * `useInterval` treats an undefined delay as "off"), so the ticker only runs while a turn is in
 * flight. Formatting is the shared `formatElapsed` (`hours` roll-over), so every surface reads the
 * same `2m 37s` / `1h 5m` breakpoints.
 *
 * Anti-drift invariant (plan 09.4 M7): the label is a pure function of the CURRENT wall clock -
 * `Date.now() - startedAt` recomputed every render and FLOORED to whole seconds by `formatElapsed` -
 * so it can never run ahead of real time regardless of tick cadence. The interval only decides HOW
 * OFTEN the label re-reads the clock, never the value. Two things would break that and make the
 * counter "feel too fast", so both are pinned by `use-elapsed-label.test.tsx`: rounding partial
 * seconds up instead of flooring, and a second live interval surviving StrictMode's double-mount.
 * Do not replace the `floor` with `round`, and do not add a parallel timer.
 */
export function useElapsedLabel(startedAt?: number): string | null {
  const [, tick] = useState(0);
  useInterval(() => tick((n) => n + 1), startedAt === undefined ? undefined : 1000);
  return startedAt === undefined ? null : formatElapsed(Date.now() - startedAt, { hours: true });
}
