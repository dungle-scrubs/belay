import type { HookDiagnosticReason, HookOutcome } from "./results";
import type { HookExecution } from "./runner";

/**
 * Per-hook run counters for Doctor (plan 25 M4, D-009): plain in-memory accounting in the
 * mcp/lsp statusSnapshot tradition - callers record each execution+outcome, Doctor (M9) reads
 * an immutable snapshot. "Slow" is a run that completes but burns more than
 * {@link SLOW_HOOK_THRESHOLD_RATIO} of the hook's own timeout budget (a timed-out run counts
 * as a timeout, not additionally as slow); repeated timeouts and failures accumulate so Doctor
 * can flag a hook that is degrading rather than one bad afternoon. Keyed by the approval key
 * the runtime passes in, matching how the rest of the runtime identifies a hook.
 *
 * Responsible for: accumulating per-hook run/slow/timeout/failure counters and the Doctor snapshot.
 * Not for: deriving outcomes (./results), building approval keys (./approval), or emitting
 * events (M9).
 */

/** A completed run slower than this fraction of the hook's timeout is "slow". */
export const SLOW_HOOK_THRESHOLD_RATIO = 0.8;

export interface HookStatsEntry {
  /** The hook's approval key (see approval.hookApprovalKey). */
  readonly key: string;
  readonly runs: number;
  /** Completed runs that burned more than the slow threshold of the timeout budget. */
  readonly slowRuns: number;
  readonly timeouts: number;
  /** command_failed outcomes: non-zero exits, signal deaths, and failed spawns. */
  readonly failures: number;
  /** invalid_json + invalid_decision outcomes: the hook ran but spoke garbage. */
  readonly invalidOutputs: number;
  readonly lastDurationMs: number;
  /** The most recent run's diagnostic reason; absent when the last run yielded a decision. */
  readonly lastDiagnostic?: HookDiagnosticReason;
}

export interface HookStats {
  /** Accounts one completed execution (under the hook's approval key) and its derived outcome;
   *  `timeoutMs` is the hook's own budget the slow threshold is measured against. */
  readonly record: (
    key: string,
    timeoutMs: number,
    execution: HookExecution,
    outcome: HookOutcome,
  ) => void;
  /** An immutable, key-sorted snapshot for Doctor; later recordings never mutate it. */
  readonly snapshot: () => readonly HookStatsEntry[];
}

interface MutableEntry {
  runs: number;
  slowRuns: number;
  timeouts: number;
  failures: number;
  invalidOutputs: number;
  lastDurationMs: number;
  lastDiagnostic?: HookDiagnosticReason;
}

/** A fresh, empty per-hook recorder (one per hooks runtime; plain in-memory state). */
export function createHookStats(): HookStats {
  const entries = new Map<string, MutableEntry>();

  return {
    record: (key, timeoutMs, execution, outcome) => {
      const entry = entries.get(key) ?? {
        runs: 0,
        slowRuns: 0,
        timeouts: 0,
        failures: 0,
        invalidOutputs: 0,
        lastDurationMs: 0,
      };
      entries.set(key, entry);

      entry.runs += 1;
      entry.lastDurationMs = execution.durationMs;
      entry.lastDiagnostic = outcome.kind === "diagnostic" ? outcome.reason : undefined;

      if (!execution.timedOut && execution.durationMs > SLOW_HOOK_THRESHOLD_RATIO * timeoutMs) {
        entry.slowRuns += 1;
      }
      if (outcome.kind !== "diagnostic") {
        return;
      }
      if (outcome.reason === "timeout") {
        entry.timeouts += 1;
      } else if (outcome.reason === "command_failed") {
        entry.failures += 1;
      } else if (outcome.reason === "invalid_json" || outcome.reason === "invalid_decision") {
        entry.invalidOutputs += 1;
      }
    },

    snapshot: () =>
      [...entries.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => ({
          key,
          runs: entry.runs,
          slowRuns: entry.slowRuns,
          timeouts: entry.timeouts,
          failures: entry.failures,
          invalidOutputs: entry.invalidOutputs,
          lastDurationMs: entry.lastDurationMs,
          ...(entry.lastDiagnostic !== undefined ? { lastDiagnostic: entry.lastDiagnostic } : {}),
        })),
  };
}
