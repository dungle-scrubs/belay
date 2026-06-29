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

/** Create + enter a managed worktree for a plan (acquiring the 01 cwd lock). Discriminated so a
 *  successful create always carries its worktree id (no second presence check at the call site). */
export type CreateEnterOutcome =
  | { readonly ok: true; readonly worktreeId: string; readonly sessionId?: string }
  | { readonly ok: false; readonly error: string };

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

/** A git op outcome (merge / delete), structurally the worktree manager's `GitResult`. */
export type GitOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

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

interface Stepper {
  /** Patch the plan's journal entry, persist, and return the new run. */
  step(patch: Parameters<typeof advancePlan>[2]): SerialRun;
  /** Terminal stop: mark the plan halted with a reason (tree preserved). */
  halt(reason: string): SerialRun;
  /** The latest run after the most recent step. */
  current(): SerialRun;
}

/** A journal stepper for one plan: every transition persists, so a crash resumes from the last step. */
function stepper(run: SerialRun, planId: string, caps: SerialDriverCaps): Stepper {
  let live = run;
  const step = (patch: Parameters<typeof advancePlan>[2]): SerialRun => {
    live = advancePlan(live, planId, patch, caps.now());
    caps.persist(live);
    return live;
  };
  return {
    step,
    halt: (reason) => step({ phase: "halted", haltReason: reason }),
    current: () => live,
  };
}

/**
 * The single green gate: clean tree -> merge -> delete -> `merged`. Any failure halts and PRESERVES the
 * tree. The only place a merge + delete is authorized - both the non-interactive {@link driveOnePlan} and
 * the host-driven {@link disposeCurrentPlan} route through here, so disposition can never diverge.
 */
async function runGreenGate(
  s: Stepper,
  planId: string,
  caps: SerialDriverCaps,
): Promise<SerialRun> {
  const worktreeId = liveEntry(s.current(), planId).worktreeId;
  if (!worktreeId) {
    return s.halt("internal: committed plan has no worktree");
  }
  const check = await caps.inspect(worktreeId);
  if (!check.clean) {
    return s.halt(`tree not clean: ${check.reason ?? "dirty or conflicted"}`);
  }
  const merged = await caps.merge(worktreeId);
  if (!merged.ok) {
    return s.halt(`merge conflict: ${merged.error}`);
  }
  const removed = await caps.remove(worktreeId);
  if (!removed.ok) {
    return s.halt(`delete failed: ${removed.error}`);
  }
  return s.step({ phase: "merged" });
}

/**
 * Drives ONE plan from its current journal phase to a terminal phase (`merged` or `halted`), persisting
 * each transition. Phase-driven so a reopened run resumes correctly: a tree already created skips create,
 * one already implemented skips straight to disposition. The non-interactive path (`implement` is a real
 * async capability); the host-driven path is {@link serialNext} + {@link disposeCurrentPlan}.
 */
export async function driveOnePlan(
  run: SerialRun,
  planId: string,
  caps: SerialDriverCaps,
): Promise<SerialRun> {
  const s = stepper(run, planId, caps);

  // 1. Create + enter the managed worktree (unless a prior run already did).
  if (liveEntry(s.current(), planId).phase === "queued") {
    const created = await caps.createEnter(planId);
    if (!created.ok) {
      return s.halt(`create/enter failed: ${created.error}`);
    }
    s.step({
      phase: "tree-created",
      worktreeId: created.worktreeId,
      ...(created.sessionId ? { sessionId: created.sessionId } : {}),
    });
  }

  // 2. Implement in the tree (resumes if we crashed mid-implement).
  const beforeImpl = liveEntry(s.current(), planId);
  if (beforeImpl.phase === "tree-created" || beforeImpl.phase === "implementing") {
    s.step({ phase: "implementing" });
    const impl = await caps.implement(planId, beforeImpl.sessionId ?? "");
    if (!impl.green) {
      return s.halt(`implementation red: ${impl.detail ?? "tests failing"}`);
    }
    s.step({ phase: "committed" });
  }

  // 3. Dispose through the single green gate.
  return runGreenGate(s, planId, caps);
}

/**
 * The host-driven half of the serial loop (the interactive path): create + enter the next QUEUED plan's
 * managed worktree and advance its journal entry to `tree-created`. Returns the plan now in progress so
 * the caller can hand the tree to the agent to implement; null when the queue is drained or a create
 * failed (which halts the run). The agent implements, then the host calls {@link disposeCurrentPlan}.
 */
export async function serialNext(
  run: SerialRun,
  caps: SerialDriverCaps,
): Promise<{ readonly run: SerialRun; readonly plan: PlanEntry | null }> {
  const next = nextPlan(run);
  if (next?.phase !== "queued") {
    return { run, plan: next }; // done / halted, or the current plan's tree already exists
  }
  const s = stepper(run, next.planId, caps);
  const created = await caps.createEnter(next.planId);
  if (!created.ok) {
    return { run: s.halt(`create/enter failed: ${created.error}`), plan: null };
  }
  const updated = s.step({
    phase: "tree-created",
    worktreeId: created.worktreeId,
    ...(created.sessionId ? { sessionId: created.sessionId } : {}),
  });
  return { run: updated, plan: liveEntry(updated, next.planId) };
}

/**
 * Dispose the in-progress plan after the agent implemented it: on green, run the single green gate
 * (clean -> merge -> delete -> `merged`); on red, halt with the reason, the tree preserved. The
 * host-driven counterpart to {@link serialNext}; advancing the durable journal in production.
 */
export async function disposeCurrentPlan(
  run: SerialRun,
  caps: SerialDriverCaps,
  outcome: ImplementOutcome,
): Promise<SerialRun> {
  const current = nextPlan(run);
  if (!current) {
    return run; // nothing in progress (queue drained or halted)
  }
  const s = stepper(run, current.planId, caps);
  if (!outcome.green) {
    return s.halt(`implementation red: ${outcome.detail ?? "tests failing"}`);
  }
  s.step({ phase: "committed" });
  return runGreenGate(s, current.planId, caps);
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
