import { join } from "node:path";
import { readJson, type WorktreeFs, writeJson } from "../worktrees/registry";

/**
 * The durable serial-run journal (plan 02, M1/M5): a re-openable record of one serial-implement run -
 * its ordered plan queue and each plan's disposition - so a crash or reopen continues from the next
 * un-disposed plan and never re-merges a completed one. Pure over the injected `WorktreeFs` (the same
 * seam the worktree registry uses), so every transition is unit-tested with an in-memory fake. Lives at
 * `<state-home>/serial-runs.json` as a runId->run map, classified under the storage inventory.
 *
 * This module owns ONLY the persisted run state and the pure resume/status derivations; the worktree
 * lifecycle and the green gate live in `driver.ts`, which calls in here to record each step.
 */

/** A queued plan's position in the per-plan lifecycle. `merged` is terminal-success (tree merged +
 *  deleted); `halted` is terminal-stop (red / conflict / dirty), preserving the tree for inspection. */
export type PlanPhase =
  | "queued"
  | "tree-created"
  | "implementing"
  | "committed"
  | "merged"
  | "halted";

/** One plan's journal entry within a run. */
export interface PlanEntry {
  readonly planId: string;
  readonly phase: PlanPhase;
  /** The managed worktree created for this plan, once `tree-created`. */
  readonly worktreeId?: string;
  /** The durable session bound to the worktree, once `tree-created`. */
  readonly sessionId?: string;
  /** Why the run halted on this plan (red tests / merge conflict / dirty tree), when `halted`. */
  readonly haltReason?: string;
  readonly updatedAt: string;
}

/** A run is `running` until every plan is `merged` (`complete`) or one `halted` (`halted`). */
export type RunStatus = "running" | "complete" | "halted";

/** One durable serial-implement run. */
export interface SerialRun {
  readonly runId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: RunStatus;
  readonly plans: readonly PlanEntry[];
}

const runsPath = (home: string): string => join(home, "serial-runs.json");

/** Derives a run's status from its plans: halted if any plan halted, complete once all merged, else
 *  running. Halt dominates so a stopped run never reads as complete. */
export function runStatusFor(plans: readonly PlanEntry[]): RunStatus {
  if (plans.some((p) => p.phase === "halted")) {
    return "halted";
  }
  return plans.every((p) => p.phase === "merged") ? "complete" : "running";
}

/** Builds the initial run for an ordered queue, every plan `queued`. */
export function newSerialRun(runId: string, queue: readonly string[], now: string): SerialRun {
  return {
    runId,
    createdAt: now,
    updatedAt: now,
    status: "running",
    plans: queue.map((planId) => ({ planId, phase: "queued" as const, updatedAt: now })),
  };
}

/** The next plan the driver should act on: the first one not yet `merged`, or null when the run is
 *  done or halted. A `halted` plan blocks resume (the run stops there until the human intervenes). */
export function nextPlan(run: SerialRun): PlanEntry | null {
  if (run.plans.some((p) => p.phase === "halted")) {
    return null;
  }
  return run.plans.find((p) => p.phase !== "merged") ?? null;
}

/** Immutably patches one plan entry (by id), restamps `updatedAt`, and recomputes run status. */
export function advancePlan(
  run: SerialRun,
  planId: string,
  patch: Partial<Omit<PlanEntry, "planId" | "updatedAt">>,
  now: string,
): SerialRun {
  const plans = run.plans.map((p) =>
    p.planId === planId ? { ...p, ...patch, updatedAt: now } : p,
  );
  return { ...run, plans, updatedAt: now, status: runStatusFor(plans) };
}

/** The persisted runId->run map, or {} when none / unreadable. Malformed entries are dropped. */
export function loadRuns(fs: WorktreeFs, home: string): Record<string, SerialRun> {
  const raw = readJson<Record<string, SerialRun>>(fs, runsPath(home), {});
  const out: Record<string, SerialRun> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value.runId === "string" && Array.isArray(value.plans)) {
      out[key] = value;
    }
  }
  return out;
}

/** One run by id, or null when it does not exist (the reopen path). */
export function loadRun(fs: WorktreeFs, home: string, runId: string): SerialRun | null {
  return loadRuns(fs, home)[runId] ?? null;
}

/** Records (or replaces) a run by id. */
export function saveRun(fs: WorktreeFs, home: string, run: SerialRun): void {
  const all = loadRuns(fs, home);
  all[run.runId] = run;
  writeJson(fs, runsPath(home), all);
}

/** All runs, newest-updated first (for a re-open chooser / status surface). */
export function listRuns(fs: WorktreeFs, home: string): SerialRun[] {
  return Object.values(loadRuns(fs, home)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
