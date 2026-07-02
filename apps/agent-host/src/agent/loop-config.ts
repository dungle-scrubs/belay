/**
 * Responsible for: the turn-loop tuning surface - the TurnLoopConfig shape, its production
 * defaults (DEFAULT_TURN_LOOP_CONFIG), and the per-turn override merge (turnLoopConfig).
 * Not for: deriving the adaptive per-step budget from live turn facts - turn-budget.ts.
 */
import { DEFAULT_STREAM_STALL_MS, DEFAULT_TOOL_STALL_MS } from "./loop-stalls";
import { EMERGENCY_MAX_STEPS } from "./turn-budget";

export interface TurnLoopConfig {
  /** Absolute runaway ceiling, independent of the adaptive per-step budget (D-011): the loop derives
   *  an effective step budget each round (see turn-budget.ts) and clamps it to never exceed this. Only
   *  binds when the adaptive budget would exceed it or telemetry is unusable - the genuine backstop. */
  readonly emergencyMaxSteps: number;
  /** Max read-only tool calls a single step runs concurrently. */
  readonly toolConcurrency: number;
  /** Prompt-token fraction of the context window where the loop stops opening tool rounds. */
  readonly contextBudgetFraction: number;
  /** Per-turn cap on in-loop overflow-recovery adjustments. */
  readonly maxRecovery: number;
  /** Provider-stream idle watchdog in ms; 0 disables it. */
  readonly streamStallMs: number;
  /** Per-tool-call wall-clock watchdog in ms; 0 disables it. */
  readonly toolStallMs: number;
  /** Reconnect backoff before retries; length + 1 is the attempt budget. */
  readonly reconnectBackoffsMs: readonly number[];
}

export const DEFAULT_TURN_LOOP_CONFIG: TurnLoopConfig = {
  emergencyMaxSteps: EMERGENCY_MAX_STEPS,
  toolConcurrency: 8,
  contextBudgetFraction: 0.8,
  maxRecovery: 2,
  streamStallMs: DEFAULT_STREAM_STALL_MS,
  toolStallMs: DEFAULT_TOOL_STALL_MS,
  // 9 backoffs -> 10 total attempts (the initial + 9 retries). The curve ramps then caps at 15s, for
  // ~75s cumulative across all retries - deliberately under the 90s per-attempt stream-stall watchdog,
  // so the watchdog still bounds any single hung attempt while a genuinely flaky upstream gets a wide
  // budget to recover. Retries fire only before any token streams (safeToRetry), so the wider budget
  // never duplicates partial output. <!-- D-001 D-002 -->
  reconnectBackoffsMs: [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000],
};

export function turnLoopConfig(overrides?: Partial<TurnLoopConfig>): TurnLoopConfig {
  return {
    ...DEFAULT_TURN_LOOP_CONFIG,
    ...overrides,
    reconnectBackoffsMs:
      overrides?.reconnectBackoffsMs ?? DEFAULT_TURN_LOOP_CONFIG.reconnectBackoffsMs,
  };
}
