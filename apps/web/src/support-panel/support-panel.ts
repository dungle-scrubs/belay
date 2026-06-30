import type { TaskSnapshot, TaskStatus } from "@trevor/session";

/**
 * The thread support-panel read model (plan 09 M5): the pure projection of a thread's support surfaces -
 * the task checklist and the background work (subagents + promoted jobs) - into render-ready rows, with
 * no React/layout coupling. The panel has a tasks section (rendered left) and a background group whose
 * rows are ordered subagents-before-jobs (the V1 model). `twoColumn` only signals that BOTH sections
 * exist; whether the layout actually splits also depends on width, which the component decides (M6).
 */

/** A promoted background job as the panel sees it - the web mirror of the host `JobSnapshot` (M7 maps
 *  the host-announced snapshots into this). */
export interface SupportJob {
  readonly id: string;
  readonly command: string;
  readonly status: "running" | "exited" | "killed";
  readonly exitCode: number | null;
}

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
  readonly jobs: readonly SupportJob[];
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

function jobRow(j: SupportJob): SupportBackgroundRow {
  const tone: SupportTone =
    j.status === "running"
      ? "running"
      : j.status === "killed" || j.exitCode !== 0
        ? "error"
        : "done";
  const statusLabel =
    j.status === "running"
      ? "running"
      : j.status === "killed"
        ? "killed"
        : j.exitCode === 0
          ? "done"
          : `exit ${j.exitCode}`;
  return { id: j.id, kind: "job", label: j.command, statusLabel, tone, detailEligible: true };
}
