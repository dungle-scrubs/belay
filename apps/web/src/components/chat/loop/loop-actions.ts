import type { LoopControl } from "@trevor/session";

/**
 * Live protocol wiring for the loop inventory (plan 17, M7). An inventory control does NOT mutate loop
 * state locally - it submits the SAME host-authoritative `/loop <verb> <id>` command an explicit typed
 * command would, so the host validates + executes it and re-publishes the resulting status (D-001/D-002).
 * Each {@link LoopControl} maps 1:1 to its command verb.
 */
export function loopControlCommand(loopId: string, control: LoopControl): string {
  return `/loop ${control} ${loopId}`;
}
