import type { TaskSnapshot, TaskStatus } from "@trevor/richter";
import { msg, optStr, strArr } from "./tools/shared";
import type { Tool } from "./tools/types";

/**
 * The agent's working checklist (the V2 port of the V1 task ledger, H-023). The
 * model maintains it with task_create / task_update; the host keeps it as the live
 * source of truth, renders it into the system prompt every turn (so it survives
 * history compaction - the model never loses track of its plan), and emits a
 * tasks.current snapshot on every change for the UI and for restore on replay.
 *
 * V1 semantics are preserved: the full status set, blockedBy/blocks dependencies
 * (a task can't start until its blockers complete), and the automatic clear -
 * completing the last open task wipes the finished checklist so it doesn't linger.
 */

interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: TaskStatus;
  blockedBy: string[];
  blocks: string[];
  createdAt: string;
  updatedAt: string;
}

interface CreateInput {
  subject: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  blockedBy?: string[];
  blocks?: string[];
}

interface UpdateInput {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus | "deleted";
  blockedBy?: string[];
  blocks?: string[];
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "pending",
  in_progress: "in progress",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

export class TaskRegistry {
  private readonly tasks = new Map<string, Task>();
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  /** Fires after every mutation (the host wires this to emit tasks.current). */
  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }

  /** A task may only start once every task it is blockedBy has completed. */
  private assertUnblocked(blockedBy: readonly string[]): void {
    for (const dep of blockedBy) {
      const blocker = this.tasks.get(dep);
      if (blocker && blocker.status !== "completed") {
        throw new Error(`cannot start: blocked by ${dep} (${blocker.status})`);
      }
    }
  }

  create(input: CreateInput): Task {
    const subject = input.subject.trim();
    if (!subject) {
      throw new Error("subject is required");
    }
    const status = input.status ?? "pending";
    const blockedBy = [...(input.blockedBy ?? [])];
    if (status === "in_progress") {
      this.assertUnblocked(blockedBy);
    }
    this.seq += 1;
    const id = `task_${this.seq}`;
    const now = new Date().toISOString();
    const task: Task = {
      id,
      subject,
      description: (input.description ?? "").trim(),
      activeForm: (input.activeForm ?? subject).trim(),
      status,
      blockedBy,
      blocks: [...(input.blocks ?? [])],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, task);
    this.notify();
    return task;
  }

  /** Updates a task, deletes it (status "deleted"), or auto-clears the checklist. */
  update(id: string, fields: UpdateInput): { task: Task | null; cleared: boolean } {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`no such task "${id}"`);
    }
    if (fields.status === "deleted") {
      this.tasks.delete(id);
      this.notify();
      return { task: null, cleared: false };
    }
    const nextStatus = fields.status ?? task.status;
    const nextBlockedBy = fields.blockedBy ?? task.blockedBy;
    if (nextStatus === "in_progress" && task.status !== "in_progress") {
      this.assertUnblocked(nextBlockedBy);
    }
    if (fields.subject !== undefined) {
      task.subject = fields.subject.trim();
    }
    if (fields.description !== undefined) {
      task.description = fields.description.trim();
    }
    if (fields.activeForm !== undefined) {
      task.activeForm = fields.activeForm.trim();
    }
    if (fields.blockedBy !== undefined) {
      task.blockedBy = [...fields.blockedBy];
    }
    if (fields.blocks !== undefined) {
      task.blocks = [...fields.blocks];
    }
    task.status = nextStatus;
    task.updatedAt = new Date().toISOString();
    // Completing the last open task clears the finished checklist (V1 behavior), so
    // a done plan doesn't linger into the next topic.
    const allDone = [...this.tasks.values()].every((t) => t.status === "completed");
    const cleared = nextStatus === "completed" && this.tasks.size > 0 && allDone;
    if (cleared) {
      this.tasks.clear();
    }
    this.notify();
    return { task: cleared ? null : task, cleared };
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  /** The wire/UI view of the current checklist. */
  snapshot(): TaskSnapshot[] {
    return this.list().map((t) => ({
      id: t.id,
      subject: t.subject,
      activeForm: t.activeForm,
      status: t.status,
      blockedBy: t.blockedBy,
      blocks: t.blocks,
    }));
  }

  /** Restores the registry from a snapshot (replay / standby sync); does NOT re-emit. */
  load(snapshot: readonly TaskSnapshot[]): void {
    this.tasks.clear();
    let max = 0;
    for (const t of snapshot) {
      this.tasks.set(t.id, {
        id: t.id,
        subject: t.subject,
        description: "",
        activeForm: t.activeForm,
        status: t.status,
        blockedBy: [...t.blockedBy],
        blocks: [...t.blocks],
        createdAt: "",
        updatedAt: "",
      });
      const n = Number(t.id.replace(/^task_/, ""));
      if (Number.isFinite(n) && n > max) {
        max = n;
      }
    }
    this.seq = Math.max(this.seq, max);
  }

  /** The ambient block injected into the system prompt each turn (empty if no tasks). */
  renderForPrompt(): string {
    const tasks = this.list();
    if (!tasks.length) {
      return "";
    }
    const rows = tasks.map((t) => {
      const dep = t.blockedBy.length ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
      return `  [${STATUS_LABEL[t.status]}] ${t.id}: ${t.activeForm}${dep}`;
    });
    return [
      "Your current task checklist (keep it current as you work; this is your plan, not the user's):",
      ...rows,
    ].join("\n");
  }
}

/** Host-wide checklist: one registry shared by the task tools, prompt, and emit. */
export const taskRegistry = new TaskRegistry();

const STATUS_ENUM: TaskStatus[] = ["pending", "in_progress", "completed", "failed", "cancelled"];

/** The model-facing checklist tools (create + update); reads are covered ambiently. */
export function buildTaskTools(registry: TaskRegistry = taskRegistry): Tool[] {
  const create: Tool = {
    name: "task_create",
    description:
      "Add a task to your working checklist (shown back to you every turn). Use it to plan and track multi-step work; skip it for trivial one-step requests, and never create fake or demo tasks. Keep exactly one task in_progress at a time.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Short imperative title of the task" },
        description: { type: "string", description: "Optional detail / acceptance" },
        activeForm: {
          type: "string",
          description: "Optional present-tense label shown while active",
        },
        status: { type: "string", enum: STATUS_ENUM },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          description: "Task ids that must finish first",
        },
        blocks: {
          type: "array",
          items: { type: "string" },
          description: "Task ids this one blocks",
        },
      },
      required: ["subject"],
    },
    execute(args) {
      try {
        const task = registry.create({
          subject: String(args.subject ?? ""),
          description: optStr(args.description),
          activeForm: optStr(args.activeForm),
          status: args.status as TaskStatus | undefined,
          blockedBy: strArr(args.blockedBy),
          blocks: strArr(args.blocks),
        });
        return Promise.resolve(`created ${task.id}: ${task.subject}`);
      } catch (error) {
        return Promise.resolve(`error: ${msg(error)}`);
      }
    },
  };

  const update: Tool = {
    name: "task_update",
    description:
      "Update a checklist task by id: set status to in_progress when you start it, completed when done, failed/cancelled if it won't be done, or deleted to retire a stale one. Completing the last open task auto-clears the whole checklist; on a new topic, delete stale tasks and create a fresh list.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The id of the task to update" },
        subject: { type: "string" },
        description: { type: "string" },
        activeForm: { type: "string" },
        status: { type: "string", enum: [...STATUS_ENUM, "deleted"] },
        blockedBy: { type: "array", items: { type: "string" } },
        blocks: { type: "array", items: { type: "string" } },
      },
      required: ["taskId"],
    },
    execute(args) {
      try {
        const { task, cleared } = registry.update(String(args.taskId ?? ""), {
          subject: optStr(args.subject),
          description: optStr(args.description),
          activeForm: optStr(args.activeForm),
          status: args.status as TaskStatus | "deleted" | undefined,
          blockedBy: strArr(args.blockedBy),
          blocks: strArr(args.blocks),
        });
        if (cleared) {
          return Promise.resolve("all tasks complete - checklist cleared");
        }
        if (!task) {
          return Promise.resolve(`deleted ${String(args.taskId ?? "")}`);
        }
        return Promise.resolve(`${task.id} -> ${task.status}`);
      } catch (error) {
        return Promise.resolve(`error: ${msg(error)}`);
      }
    },
  };

  return [create, update];
}
