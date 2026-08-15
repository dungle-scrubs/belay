import {
  isTerminalDelegationStatus,
  type JobSnapshot,
  type TaskSnapshot,
  type TaskStatus,
} from "@belay/session";
import type { ToolDetailModel } from "@/tool-detail/detail-model";
import type { Message } from "@/transcript";
import { taskRowLabel } from "../tasks-display";

/**
 * The thread support-panel read model (plan 09 M5): the pure projection of a thread's support surfaces -
 * the task checklist and the background work (subagents + promoted jobs) - into render-ready rows, with
 * no React/layout coupling. The panel has a tasks section (rendered left) and a background group whose
 * rows are ordered subagents-before-jobs (the V1 model). `twoColumn` only signals that BOTH sections
 * exist; whether the layout actually splits also depends on width, which the component decides (M6).
 */

/** A background subagent delegation row (projected from a `delegation` transcript message). */
export interface SupportSubagent {
  readonly id: string;
  readonly agent: string;
  readonly task: string;
  /** The delegation status string: running / done / failed / interrupted (D-002). */
  readonly status: string;
}

/**
 * A promoted job as the panel sees it: the host's wire {@link JobSnapshot} plus a derive-layer
 * `interrupted` flag (plan 52 / D-003). The flag is set by `jobsFrom` when the job's `host.online`
 * author is no longer the live leader - a `running` job whose owning host vanished is really orphaned,
 * so the panel renders it interrupted (terminal, kill control inert) instead of a stuck "running".
 * Presentation-only: jobs carry no durable event, so there is no `interrupted` lifecycle on the wire.
 */
export type PanelJob = JobSnapshot & { readonly interrupted?: boolean };

export type SupportTone = "running" | "done" | "error";

export interface SupportTaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
}

export interface SupportBackgroundRow {
  readonly id: string;
  readonly kind: "subagent" | "job";
  /** The agent name (subagent) or the command (job). */
  readonly label: string;
  readonly statusLabel: string;
  readonly tone: SupportTone;
  /** A job opens the tool-detail takeover; a subagent links to its child session instead, so only jobs
   *  are detail-eligible from this panel (M8). */
  readonly detailEligible: boolean;
  /** Terminal jobs can be dismissed from the host's in-memory job registry; running jobs must be stopped. */
  readonly dismissEligible: boolean;
}

export interface ThreadSupportPanel {
  readonly tasks: readonly SupportTaskRow[];
  readonly background: readonly SupportBackgroundRow[];
  readonly hasTasks: boolean;
  readonly hasBackground: boolean;
  /** Both sections are non-empty, so the panel MAY render two columns (M6 also gates on width). */
  readonly twoColumn: boolean;
  readonly taskCount: number;
  readonly backgroundCount: number;
}

export function buildSupportPanel(input: {
  readonly tasks: readonly TaskSnapshot[];
  readonly subagents: readonly SupportSubagent[];
  readonly jobs: readonly PanelJob[];
}): ThreadSupportPanel {
  const tasks: SupportTaskRow[] = input.tasks.map((t) => ({
    id: t.id,
    title: taskRowLabel(t),
    status: t.status,
  }));
  // Subagents before jobs within the background group (the V1 ordering).
  const background: SupportBackgroundRow[] = [
    ...input.subagents.map(subagentRow),
    ...input.jobs.map(jobRow),
  ];
  return {
    tasks,
    background,
    hasTasks: tasks.length > 0,
    hasBackground: background.length > 0,
    twoColumn: tasks.length > 0 && background.length > 0,
    taskCount: tasks.length,
    backgroundCount: background.length,
  };
}

/** A job's terminal disposition, the single source of truth for both its panel-row tone and its
 *  detail-model status (they previously disagreed on an exited job with a null exit code). An
 *  `interrupted` job (its host vanished, D-003) is terminal, rendered with the error/terminal tone the
 *  turn's interrupted note uses. Otherwise: a `running` job is in flight; a killed job or one that exited
 *  non-zero is an error; anything else is done (an exit code of 0 or an absent code from a clean exit). */
export function jobOutcome(
  job: Pick<JobSnapshot, "status" | "exitCode"> & { readonly interrupted?: boolean },
): SupportTone {
  if (job.interrupted) {
    return "error";
  }
  if (job.status === "running") {
    return "running";
  }
  return job.status === "killed" || (job.exitCode ?? 0) !== 0 ? "error" : "done";
}

export function jobDismissEligible(job: PanelJob): boolean {
  return !job.interrupted && jobOutcome(job) !== "running";
}

/**
 * Maps a promoted job to the shared tool-detail model (plan 09 M8 REFACTOR), so a job opens the SAME
 * detail takeover as a transcript tool row. The command + cwd ride the args (the bash detail body reads
 * them); the bounded tail is the output; the outcome maps to running/done/error (a killed job is aborted).
 */
export function jobToDetailModel(job: PanelJob): ToolDetailModel {
  const status = jobOutcome(job);
  return {
    id: job.id,
    source: "shell",
    // The bash detail body renders Command + working directory + Output, which fits a job exactly.
    toolName: "bash",
    status,
    aborted: job.status === "killed",
    args: JSON.stringify({ command: job.command, cwd: job.cwd }),
    ...(job.tail ? { output: job.tail } : {}),
    ...(status === "error"
      ? {
          error: job.interrupted
            ? "interrupted - the host that owned this job went away"
            : job.status === "killed"
              ? "stopped"
              : `exited with code ${job.exitCode}`,
        }
      : {}),
  };
}

/** The live BACKGROUND subagents (plan 09 M7): the non-terminal `delegation` rows from the transcript -
 *  a finished/failed/interrupted child is no longer "background work" and stays in the transcript
 *  instead. `interrupted` (a child reaped by orphan recovery, D-002) is terminal like done/failed.
 *  A blocking `delegate_inline` agent (plan 09.4) is NOT background work, so it is excluded here - but
 *  the exclusion is structural, not a mode filter: the transcript reducer already routes inline-AGENT
 *  delegations to a separate `inlineAgent` message (not `delegation`), so they never reach this loop,
 *  while background children AND workflow leaves (which keep the `delegation` kind) still surface here. */
export function runningSubagents(messages: readonly Message[]): SupportSubagent[] {
  const out: SupportSubagent[] = [];
  for (const m of messages) {
    if (m.kind === "delegation" && !isTerminalDelegationStatus(m.status)) {
      out.push({ id: m.childSessionId, agent: m.agent, task: m.task, status: m.status });
    }
  }
  return out;
}

function subagentRow(s: SupportSubagent): SupportBackgroundRow {
  // `interrupted` (orphan-reaped, D-002) shares the error/terminal tone but keeps its own status label,
  // so it reads as recovered-not-crashed rather than a genuine `failed`.
  const tone: SupportTone =
    s.status === "failed" || s.status === "interrupted"
      ? "error"
      : s.status === "done"
        ? "done"
        : "running";
  return {
    id: s.id,
    kind: "subagent",
    label: s.agent,
    statusLabel: s.status,
    tone,
    detailEligible: false,
    dismissEligible: false,
  };
}

function jobRow(job: PanelJob): SupportBackgroundRow {
  const tone = jobOutcome(job);
  const statusLabel = job.interrupted
    ? "interrupted"
    : job.status === "killed"
      ? "killed"
      : tone === "running"
        ? "running"
        : tone === "error"
          ? `exit ${job.exitCode}`
          : "done";
  return {
    id: job.id,
    kind: "job",
    label: job.command,
    statusLabel,
    tone,
    detailEligible: true,
    dismissEligible: jobDismissEligible(job),
  };
}
