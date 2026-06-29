import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WorktreeManager } from "../worktrees/manager";
import { nodeWorktreeFs } from "../worktrees/node";
import type { CreateEnterOutcome, GitOutcome, ImplementOutcome, SerialDriverCaps } from "./driver";
import type { SerialRunStartDeps } from "./entry";
import { type SerialRun, saveRun } from "./journal";

/**
 * The node-backed wiring for serial runs (plan 02): real plan listing, real start deps, and the
 * worktree-manager-backed {@link SerialDriverCaps} the durable run executes. It adds NO git plumbing -
 * `createEnter / inspect / merge / remove` route entirely through the shipped {@link WorktreeManager}
 * (`createFromCwd / summaries / mergeBack / remove`); only the `implement` step is left as the injected
 * seam (planner implement-mode, fulfilled by the run session's agent). The mapping is kept behind the
 * narrow {@link SerialWorktreeOps} interface so the caps wiring is unit-tested with an in-memory fake.
 *
 * This is the per-leaf seam `46-worktree-fleet` reuses (D-005): the same caps, driven N-at-a-time.
 */

/** The worktree operations the serial driver needs, narrowed so the caps wiring is testable. */
export interface SerialWorktreeOps {
  /** Create the managed worktree for a plan (on `feat/<planId>`), returning its id + bound session. */
  create(planId: string): CreateEnterOutcome;
  /** The tree's clean/mergeable state (dirty or conflicted blocks the merge gate). */
  cleanState(worktreeId: string): { readonly clean: boolean; readonly reason?: string };
  /** Merge the worktree branch back to the base. */
  merge(worktreeId: string): GitOutcome;
  /** Delete the worktree directory + record (no force - a dirty tree is refused, halting safely). */
  remove(worktreeId: string): GitOutcome;
}

/** Adapts the shipped {@link WorktreeManager} (sync, cwd-bound) to {@link SerialWorktreeOps}. */
export function nodeWorktreeOps(manager: WorktreeManager, cwd: string): SerialWorktreeOps {
  return {
    create: (planId) => {
      const result = manager.createFromCwd({ cwd, branch: `feat/${planId}`, baseRef: "HEAD" });
      return result.ok
        ? { ok: true, worktreeId: result.record.id, sessionId: result.record.sessionId }
        : { ok: false, error: result.error };
    },
    cleanState: (worktreeId) => {
      const summary = manager.summaries(cwd).find((s) => s.id === worktreeId);
      if (!summary) {
        return { clean: false, reason: "worktree not found" };
      }
      if (summary.conflict) {
        return { clean: false, reason: "merge conflict in tree" };
      }
      return summary.dirty ? { clean: false, reason: "uncommitted changes" } : { clean: true };
    },
    merge: (worktreeId) => manager.mergeBack(worktreeId, cwd),
    remove: (worktreeId) => manager.remove(worktreeId, cwd, false),
  };
}

/** Builds the serial-driver capabilities from worktree ops + the injected implement seam + journal save. */
export function serialDriverCaps(opts: {
  readonly ops: SerialWorktreeOps;
  readonly implement: (planId: string, sessionId: string) => Promise<ImplementOutcome>;
  readonly persist: (run: SerialRun) => void;
  readonly now: () => string;
}): SerialDriverCaps {
  return {
    createEnter: async (planId) => opts.ops.create(planId),
    implement: opts.implement,
    inspect: async (worktreeId) => opts.ops.cleanState(worktreeId),
    merge: async (worktreeId) => opts.ops.merge(worktreeId),
    remove: async (worktreeId) => opts.ops.remove(worktreeId),
    now: opts.now,
    persist: opts.persist,
  };
}

/** The plan dirs under `<workspace>/.plans/` that are real plans (carry a `plan.db`), sorted. */
export function nodeAvailablePlans(workspace: string): string[] {
  const plansDir = join(workspace, ".plans");
  try {
    return readdirSync(plansDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(plansDir, d.name, "plan.db")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Builds the real start deps for `startSerialRun`: plan listing, journal persistence under the state
 *  home, and the handoff spawn (supplied by main.ts, which owns the transport/host wiring). */
export function nodeSerialRunStartDeps(opts: {
  readonly workspace: string;
  readonly stateHome: string;
  readonly newRunId: () => string;
  readonly now: () => string;
  readonly handoff: (
    prompt: string,
  ) => Promise<{ readonly ok: boolean; readonly targetSessionId?: string }>;
}): SerialRunStartDeps {
  return {
    availablePlans: () => nodeAvailablePlans(opts.workspace),
    newRunId: opts.newRunId,
    now: opts.now,
    saveRun: (run) => saveRun(nodeWorktreeFs, opts.stateHome, run),
    handoff: opts.handoff,
  };
}
