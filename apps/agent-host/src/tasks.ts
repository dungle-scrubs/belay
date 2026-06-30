import { type TaskSnapshot, type TaskStatus, taskSnapshotReplaces } from "@trevor/session";
import { Effect, Schema } from "effect";
import { msg } from "./messages";
// Leaf imports, not the `./tools` barrel: the barrel's TOOLS array calls `buildTaskTools()` at top
// level, so importing the barrel here would be a fatal initialization cycle (the barrel re-exports
// these same names for external consumers).
import { ToolExecutionError } from "./tools/errors";
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

/**
 * The outcome of an update, named instead of encoded by `task: null`: the task was
 * deleted, completing it cleared the whole checklist, or it was updated in place. The
 * tool renders each to its model-facing line; genuine not-found stays a thrown error.
 */
export type UpdateResult =
  | { readonly kind: "deleted" }
  | { readonly kind: "cleared" }
  | { readonly kind: "updated"; readonly task: Task };

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
  /**
   * A monotonic revision bumped on every mutation, rides each tasks.current as its freshness stamp.
   * Kept SEPARATE from the per-task `seq` id allocator (clearing + recreating tasks resets ids but
   * must not rewind freshness), so a stale snapshot can never clobber newer state. <!-- D-004 -->
   */
  private rev = 0;
  private readonly listeners = new Set<() => void>();

  /** Fires after every mutation (the host wires this to emit tasks.current). */
  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  /** The current freshness revision, stamped onto each emitted snapshot. */
  revision(): number {
    return this.rev;
  }

  private notify(): void {
    this.rev += 1;
    for (const fn of this.listeners) {
      fn();
    }
  }

  /**
   * Resolves a model-supplied task id to a real registry key, tolerating a missing `task_` prefix.
   * Models (esp. local ones like GLM/MiniMax) routinely call task_update with the BARE number - "36"
   * for `task_36` - and a strict `Map.get` rejected those as `no such task`, so the model's progress
   * updates silently failed and the checklist froze stale. Returns the canonical id when a matching
   * task exists, else undefined (a genuinely unknown id still surfaces as not-found). <!-- 09.1 -->
   */
  resolveId(id: string): string | undefined {
    const raw = id.trim();
    if (this.tasks.has(raw)) {
      return raw;
    }
    const prefixed = raw.startsWith("task_") ? raw : `task_${raw}`;
    return this.tasks.has(prefixed) ? prefixed : undefined;
  }

  /** A task may only start once every task it is blockedBy has completed. */
  private assertUnblocked(blockedBy: readonly string[]): void {
    for (const dep of blockedBy) {
      const blocker = this.tasks.get(this.resolveId(dep) ?? dep);
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

  /** Updates a task, deletes it (status "deleted"), or auto-clears the checklist. Throws
   *  on an unknown id; the task tool catches that into the typed `E` channel. */
  update(id: string, fields: UpdateInput): UpdateResult {
    const task = this.tasks.get(this.resolveId(id) ?? id);

    if (!task) {
      throw new Error(`no such task "${id}"`);
    }

    if (fields.status === "deleted") {
      this.tasks.delete(task.id);
      this.notify();
      return { kind: "deleted" };
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

    return cleared ? { kind: "cleared" } : { kind: "updated", task };
  }

  /**
   * Clears the whole checklist at the user's request (the panel's dismiss control). Distinct from the
   * auto-clear, which only fires when the model completes the LAST task (tasks.ts `update`): this lets
   * the owner retire a checklist the model abandoned on a topic change - the gap behind the "stale
   * tasks" complaint. Emits a fresh empty snapshot via `notify()` so standbys and every web client
   * converge. Returns how many tasks were dropped (0 = already empty, no emit). <!-- 09.1 -->
   */
  clear(): number {
    const count = this.tasks.size;
    if (count > 0) {
      this.tasks.clear();
      this.notify();
    }
    return count;
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

  /**
   * Restores from a snapshot ONLY when it is at least as fresh as the current state (replay / standby
   * sync), adopting its revision so later mutations stay monotonic. Returns whether it was applied. A
   * strictly older snapshot - a late delivery or an out-of-order replay - is rejected so it cannot
   * clobber newer task state; an equal revision (incl. legacy 0) applies, so an ordered replay still
   * ends on the latest snapshot. Never re-emits. The freshness rule is shared with the web derivation
   * via `taskSnapshotReplaces`. <!-- D-004 -->
   */
  loadIfFresh(snapshot: readonly TaskSnapshot[], rev: number): boolean {
    if (!taskSnapshotReplaces(rev, this.rev)) {
      return false;
    }

    this.load(snapshot);
    this.rev = rev;

    return true;
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
      "Your task checklist - the single task list for this session. You own it (task_create / task_update), and it is exactly what the user sees in their task panel. Keep it current as you work. When the user asks about tasks - what exists, what's left, what's stale, cleaning up - THIS list is the authority; read and report it directly rather than asking them to paste it:",
      ...rows,
    ].join("\n");
  }
}

/** Host-wide checklist: one registry shared by the task tools, prompt, and emit. */
export const taskRegistry = new TaskRegistry();

const STATUS_ENUM: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
];

/** An optional list of task ids; a readonly array is copied at the registry boundary. */
const TaskIds = Schema.optional(Schema.Array(Schema.String));

/** A list arg decodes to a readonly array; the registry takes mutable ids, so copy it. */
const ids = (value: readonly string[] | undefined): string[] | undefined =>
  value ? [...value] : undefined;

const CreateParams = Schema.Struct({
  subject: Schema.String.annotations({ description: "Short imperative title of the task" }),
  description: Schema.optional(Schema.String).annotations({
    description: "Optional detail / acceptance",
  }),
  activeForm: Schema.optional(Schema.String).annotations({
    description: "Optional present-tense label shown while active",
  }),
  status: Schema.optional(Schema.Literal(...STATUS_ENUM)),
  blockedBy: TaskIds.annotations({ description: "Task ids that must finish first" }),
  blocks: TaskIds.annotations({ description: "Task ids this one blocks" }),
});

const UpdateParams = Schema.Struct({
  taskId: Schema.String.annotations({ description: "The id of the task to update" }),
  subject: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  activeForm: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literal(...STATUS_ENUM, "deleted")),
  blockedBy: TaskIds,
  blocks: TaskIds,
});

/** The model-facing checklist tools (create + update); reads are covered ambiently. */
export function buildTaskTools(
  registry: TaskRegistry = taskRegistry,
): [Tool<typeof CreateParams.Type>, Tool<typeof UpdateParams.Type>] {
  const create: Tool<typeof CreateParams.Type> = {
    name: "task_create",
    description:
      "Add a task to your working checklist - the single task list for this session, shown live in the user's task panel and back to you in the prompt every turn. Use it to plan and track multi-step work; skip it for trivial one-step requests, and never create fake or demo tasks. Keep exactly one task in_progress at a time.",
    params: CreateParams,
    execute: (args) =>
      Effect.try({
        try: () => {
          const task = registry.create({
            subject: args.subject,
            description: args.description,
            activeForm: args.activeForm,
            status: args.status,
            blockedBy: ids(args.blockedBy),
            blocks: ids(args.blocks),
          });

          return `created ${task.id}: ${task.subject}`;
        },
        catch: (cause) =>
          new ToolExecutionError({
            tool: "task_create",
            detail: msg(cause),
            cause,
          }),
      }),
  };

  const update: Tool<typeof UpdateParams.Type> = {
    name: "task_update",
    description:
      "Update a task on your working checklist - the single task list for this session, shown in the user's task panel - by id: set status to in_progress when you start it, completed when done, failed/cancelled if it won't be done, or deleted to retire a stale one. Completing the last open task auto-clears the whole checklist; on a new topic, delete stale tasks and create a fresh list.",
    params: UpdateParams,
    execute: (args) =>
      Effect.try({
        try: () => {
          const result = registry.update(args.taskId, {
            subject: args.subject,
            description: args.description,
            activeForm: args.activeForm,
            status: args.status,
            blockedBy: ids(args.blockedBy),
            blocks: ids(args.blocks),
          });

          switch (result.kind) {
            case "cleared":
              return "all tasks complete - checklist cleared";
            case "deleted":
              return `deleted ${args.taskId}`;
            case "updated":
              return `${result.task.id} -> ${result.task.status}`;
          }
        },
        catch: (cause) =>
          new ToolExecutionError({
            tool: "task_update",
            detail: msg(cause),
            cause,
          }),
      }),
  };

  return [create, update];
}
