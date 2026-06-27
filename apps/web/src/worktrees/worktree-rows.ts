import type { SessionActivity, WorktreeSummary } from "@trevor/session";
import type { CommandRow, RowTone } from "@/components/command-modal";

/** Per-session activity decoration, cross-referenced from the resume inventory when available. */
export interface WorktreeActivity {
  readonly host: "live" | "stale" | "none";
  readonly activity: SessionActivity;
}

export interface WorktreeRowsContext {
  /** Map of sessionId → activity (host presence + run state), from the session inventory. */
  readonly activityBySession?: ReadonlyMap<string, WorktreeActivity>;
  /** Whether the current workspace has a turn in flight (switching is blocked while busy). */
  readonly busy: boolean;
}

/** A compact `dirty ↑a ↓b` / `conflict` delta string for a worktree's git state. */
function deltaText(s: WorktreeSummary): string {
  if (s.missing) {
    return "missing";
  }
  if (s.conflict) {
    return "rebase conflict";
  }
  const parts: string[] = [];
  if (s.dirty) {
    parts.push("dirty");
  }
  if (s.ahead > 0) {
    parts.push(`↑${s.ahead}`);
  }
  if (s.behind > 0) {
    parts.push(`↓${s.behind}`);
  }
  return parts.length > 0 ? parts.join(" ") : "clean";
}

/** The status text + tone: attention/agent state first, else the git delta. */
function statusFor(
  s: WorktreeSummary,
  activity?: WorktreeActivity,
): { status: string; tone: RowTone } {
  if (s.missing) {
    return { status: "missing", tone: "danger" };
  }
  if (s.conflict) {
    return { status: "rebase conflict", tone: "danger" };
  }
  if (activity?.activity === "running") {
    return { status: "agents running", tone: "active" };
  }
  if (activity?.host === "live") {
    return { status: "needs you", tone: "attention" };
  }
  const delta = deltaText(s);
  return { status: delta, tone: s.dirty || s.ahead > 0 || s.behind > 0 ? "attention" : "muted" };
}

/**
 * Projects the host-announced managed worktrees into command-modal rows for the switcher (D-091),
 * grouped by base repo, the baseline checkout first within each group. Git deltas + an optional
 * cross-referenced session activity drive the status; the current row is marked and disabled
 * (no switch-to-self), and - while the current workspace is busy - every other row is disabled,
 * enforcing the switch-blocked safety rule. A missing worktree is disabled with a repair reason.
 * Pure; the source summaries are never mutated.
 */
export function buildWorktreeRows(
  worktrees: readonly WorktreeSummary[],
  ctx: WorktreeRowsContext,
): CommandRow[] {
  // The host announces each base repo's rows baseline-first; `group` (baseRepoName) lets the
  // modal's groupRows partition them by repo in first-seen order, so no reordering is needed.
  return worktrees.map((s) => {
    const activity = ctx.activityBySession?.get(s.sessionId);
    const { status, tone } = statusFor(s, activity);
    const disabledReason = s.missing
      ? "missing — needs repair"
      : s.current
        ? "current worktree"
        : ctx.busy
          ? "finish the current run first"
          : undefined;

    return {
      id: s.id,
      label: s.baseline ? `${s.branch} (baseline)` : s.branch,
      metadata: s.path,
      status,
      statusTone: tone,
      current: s.current,
      disabledReason,
      keywords: [s.baseRepoName, s.branch, s.baseline ? "baseline" : "", s.sessionId].filter(
        Boolean,
      ),
      group: s.baseRepoName,
    };
  });
}
