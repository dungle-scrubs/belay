import { advancePlan, nextPlan, type PlanEntry, type SerialRun } from "./journal";

/**
 * The serial driver (plan 02, M2-M5): runs a queue of plans strictly ONE managed worktree at a time -
 * for each plan, create+enter a tree, implement in it, then on a green+clean tree commit -> merge ->
 * delete, else HALT and preserve the tree for inspection. Pure over the injected {@link SerialDriverCaps}
 * (worktree create/merge/delete, the implement step, the clean check, the clock, and journal persistence),
 * so every disposition branch and the resume path are unit-tested with fakes - the real host wires
 * `WorktreeManager` + the cwd lock + planner implement-mode behind the same seam.
 *
 * {@link driveOnePlan} is the reusable per-plan lifecycle unit; `46-worktree-fleet` parallelizes exactly
 * this unit per leaf (D-005). The driver never holds two mutating trees at once: the next plan's tree is
 * created only after the prior plan reaches `merged`, because {@link nextPlan} does not advance until then.
 */

/** Create + enter a managed worktree for a plan (acquiring the 01 cwd lock). */
export interface CreateEnterOutcome {
  readonly ok: boolean;
  readonly worktreeId?: string;
  readonly sessionId?: string;
  readonly error?: string;
}

/** The result of running the implement step in a tree: green = the plan's own gate passed. */
export interface ImplementOutcome {
  readonly green: boolean;
  readonly detail?: string;
}

/** Whether a tree is clean + mergeable (not dirty / not conflicted) before the merge gate. */
export interface CleanCheck {
  readonly clean: boolean;
  readonly reason?: string;
}

/** A git op outcome (merge / delete), mirroring the worktree manager's `GitResult`. */
export interface GitOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

/** The effects the serial driver orchestrates; the host wires the real worktree/implement behind them. */
export interface SerialDriverCaps {
  /** Create + enter a managed worktree for the plan. */
  createEnter(planId: string): Promise<CreateEnterOutcome>;
  /** Implement the plan inside its tree (planner implement-mode); green = the plan's gate passed. */
  implement(planId: string, sessionId: string): Promise<ImplementOutcome>;
  /** Inspect the tree before merge: clean + mergeable, or the reason it is not. */
  inspect(worktreeId: string): Promise<CleanCheck>;
  /** Merge the worktree branch back to the base. */
  merge(worktreeId: string): Promise<GitOutcome>;
  /** Delete the worktree directory + record (and release the cwd lock). */
  remove(worktreeId: string): Promise<GitOutcome>;
  now(): string;
  /** Persist the journal after each transition, so a crash resumes from the next un-disposed step. */
  persist(run: SerialRun): void;
}

function liveEntry(run: SerialRun, planId: string): PlanEntry {
  const entry = run.plans.find((p) => p.planId === planId);
  if (!entry) {
    throw new Error(`serial-run: plan ${planId} not in run ${run.runId}`);
  }
  return entry;
}

/**
 * Drives ONE plan from its current journal phase to a terminal phase (`merged` or `halted`), persisting
 * each transition. Phase-driven so a reopened run resumes correctly: a tree already created skips create,
 * one already implemented skips straight to disposition. The single green gate ({@link CleanCheck} +
 * merge) is the only place a merge + delete is authorized; any failure halts and preserves the tree.
 */
export async function driveOnePlan(
  run: SerialRun,
  planId: string,
  caps: SerialDriverCaps,
): Promise<SerialRun> {
  let current = run;
  const step = (patch: Parameters<typeof advancePlan>[2]): SerialRun => {
    current = advancePlan(current, planId, patch, caps.now());
    caps.persist(current);
    return current;
  };
  const halt = (reason: string): SerialRun => step({ phase: "halted", haltReason: reason });

  // 1. Create + enter the managed worktree (unless a prior run already did).
  if (liveEntry(current, planId).phase === "queued") {
    const created = await caps.createEnter(planId);
    if (!created.ok || !created.worktreeId) {
      return halt(`create/enter failed: ${created.error ?? "unknown error"}`);
    }
    step({
      phase: "tree-created",
      worktreeId: created.worktreeId,
      ...(created.sessionId ? { sessionId: created.sessionId } : {}),
    });
  }

  // 2. Implement in the tree (resumes if we crashed mid-implement).
  const beforeImpl = liveEntry(current, planId);
  if (beforeImpl.phase === "tree-created" || beforeImpl.phase === "implementing") {
    step({ phase: "implementing" });
    const impl = await caps.implement(planId, beforeImpl.sessionId ?? "");
    if (!impl.green) {
      return halt(`implementation red: ${impl.detail ?? "tests failing"}`);
    }
    step({ phase: "committed" });
  }

  // 3. The single green gate: clean tree -> merge -> delete. Anything else halts, tree preserved.
  const worktreeId = liveEntry(current, planId).worktreeId;
  if (!worktreeId) {
    return halt("internal: committed plan has no worktree");
  }
  const check = await caps.inspect(worktreeId);
  if (!check.clean) {
    return halt(`tree not clean: ${check.reason ?? "dirty or conflicted"}`);
  }
  const merged = await caps.merge(worktreeId);
  if (!merged.ok) {
    return halt(`merge conflict: ${merged.error ?? "merge failed"}`);
  }
  const removed = await caps.remove(worktreeId);
  if (!removed.ok) {
    return halt(`delete failed: ${removed.error ?? "remove failed"}`);
  }
  return step({ phase: "merged" });
}

/**
 * Runs the whole queue strictly serially: process the next un-disposed plan to terminal, repeat, and
 * stop the moment one halts (its tree + branch preserved). Returns the final run (also persisted). Never
 * starts the next plan's tree until the prior reached `merged`, so at most one mutating tree is alive.
 */
export async function driveSerialRun(
  initial: SerialRun,
  caps: SerialDriverCaps,
): Promise<SerialRun> {
  let run = initial;
  for (let plan = nextPlan(run); plan; plan = nextPlan(run)) {
    run = await driveOnePlan(run, plan.planId, caps);
    if (run.status === "halted") {
      break;
    }
  }
  return run;
}
