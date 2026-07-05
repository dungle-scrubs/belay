import { useInterval } from "ahooks";
import { useState } from "react";
import { formatElapsed } from "@/derive";

/**
 * Live elapsed since `startedAt` (ms epoch), re-rendered each second; null when no start time.
 *
 * The single owner of the "tick a human elapsed label once per second" behavior, shared by the
 * `ActionShimmer` turn form and the pinned `TurnStatusHeader` (plan 50) so neither hand-rolls its own
 * timer. An undefined `startedAt` PAUSES the interval (ahooks `useInterval` treats an undefined delay
 * as "off"), so the ticker only runs while a turn is in flight. Formatting is the shared
 * `formatElapsed` (`hours` roll-over), so both surfaces read the same `2m 37s` / `1h 5m` breakpoints.
 */
export function useElapsedLabel(startedAt?: number): string | null {
  const [, tick] = useState(0);
  useInterval(() => tick((n) => n + 1), startedAt === undefined ? undefined : 1000);
  return startedAt === undefined ? null : formatElapsed(Date.now() - startedAt, { hours: true });
}
