import type { JobSnapshot, TaskSnapshot, TaskStatus } from "@trevor/session";
import type { ToolDetailModel } from "@/tool-detail/detail-model";
import type { Message } from "@/transcript";

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
  /** The delegation status string: running / done / failed (and friends). */
  readonly status: string;
}

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
  readonly jobs: readonly JobSnapshot[];
}): ThreadSupportPanel {
  const tasks: SupportTaskRow[] = input.tasks.map((t) => ({
    id: t.id,
    title: t.subject || t.activeForm,
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
 *  detail-model status (they previously disagreed on an exited job with a null exit code). A `running`
 *  job is in flight; a killed job or one that exited non-zero is an error; anything else is done (an
 *  exit code of 0 or an absent code from a clean exit). */
export function jobOutcome(job: Pick<JobSnapshot, "status" | "exitCode">): SupportTone {
  if (job.status === "running") {
    return "running";
  }
  return job.status === "killed" || (job.exitCode ?? 0) !== 0 ? "error" : "done";
}

/**
 * Maps a promoted job to the shared tool-detail model (plan 09 M8 REFACTOR), so a job opens the SAME
 * detail takeover as a transcript tool row. The command + cwd ride the args (the bash detail body reads
 * them); the bounded tail is the output; the outcome maps to running/done/error (a killed job is aborted).
 */
export function jobToDetailModel(job: JobSnapshot): ToolDetailModel {
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
      ? { error: job.status === "killed" ? "stopped" : `exited with code ${job.exitCode}` }
      : {}),
  };
}

/** The live background subagents (plan 09 M7): the non-terminal `delegation` rows from the transcript -
 *  a finished/failed child is no longer "background work" and stays in the transcript instead. */
export function runningSubagents(messages: readonly Message[]): SupportSubagent[] {
  const out: SupportSubagent[] = [];
  for (const m of messages) {
    if (m.kind === "delegation" && m.status !== "done" && m.status !== "failed") {
      out.push({ id: m.childSessionId, agent: m.agent, task: m.task, status: m.status });
    }
  }
  return out;
}

function subagentRow(s: SupportSubagent): SupportBackgroundRow {
  const tone: SupportTone =
    s.status === "failed" ? "error" : s.status === "done" ? "done" : "running";
  return {
    id: s.id,
    kind: "subagent",
    label: s.agent,
    statusLabel: s.status,
    tone,
    detailEligible: false,
  };
}

function jobRow(job: JobSnapshot): SupportBackgroundRow {
  const tone = jobOutcome(job);
  const statusLabel =
    job.status === "killed"
      ? "killed"
      : tone === "running"
        ? "running"
        : tone === "error"
          ? `exit ${job.exitCode}`
          : "done";
  return { id: job.id, kind: "job", label: job.command, statusLabel, tone, detailEligible: true };
}
