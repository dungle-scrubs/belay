import { ToolExecutionError, ToolInputError } from "@host/tools/errors";
import type { Tool } from "@host/tools/types";
import { msg } from "@host/transport/messages";
import { type TaskSnapshot, type TaskStatus, taskSnapshotReplaces } from "@trevor/session";
import { Effect, Schema } from "effect";

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
 *
 * Responsible for: the task_create/task_update tools and the live in-memory task ledger,
 * including dependency rules and the auto-clear.
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

/**
 * A domain precondition on the model-supplied arguments failed (empty subject, unknown
 * task id, starting a still-blocked task). The registry stays a plain class, so it throws
 * this marker instead of failing an Effect; the tool boundary maps it to `ToolInputError`
 * (bad call) rather than `ToolExecutionError` (delegated operation broke).
 */
export class TaskPreconditionError extends Error {}

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
        throw new TaskPreconditionError(`cannot start: blocked by ${dep} (${blocker.status})`);
      }
    }
  }

  create(input: CreateInput): Task {
    const subject = input.subject.trim();

    if (!subject) {
      throw new TaskPreconditionError("subject is required");
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

  /**
   * Applies one update in place (status / fields / delete) WITHOUT notifying or auto-clearing - the
   * shared core of {@link update} and {@link updateMany}. Throws on an unknown id (a bare-number id is
   * tolerated via {@link resolveId}).
   */
  private applyUpdate(
    id: string,
    fields: UpdateInput,
  ): { readonly kind: "deleted" } | { readonly kind: "updated"; readonly task: Task } {
    const task = this.tasks.get(this.resolveId(id) ?? id);

    if (!task) {
      throw new TaskPreconditionError(`no such task "${id}"`);
    }

    if (fields.status === "deleted") {
      this.tasks.delete(task.id);
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

    return { kind: "updated", task };
  }

  /** Clears the finished checklist once every task is completed (V1 "a done plan doesn't linger"); the
   *  single-completion trigger for {@link update} and the end-of-batch trigger for {@link updateMany}. */
  private autoClearIfDone(): boolean {
    const allDone =
      this.tasks.size > 0 && [...this.tasks.values()].every((t) => t.status === "completed");

    if (allDone) {
      this.tasks.clear();
    }

    return allDone;
  }

  /** Updates a task, deletes it (status "deleted"), or auto-clears the checklist. Throws
   *  on an unknown id; the task tool catches that into the typed `E` channel. */
  update(id: string, fields: UpdateInput): UpdateResult {
    const result = this.applyUpdate(id, fields);
    // Completing the last open task clears the finished checklist.
    const cleared =
      result.kind === "updated" && result.task.status === "completed" && this.autoClearIfDone();

    this.notify();

    return cleared ? { kind: "cleared" } : result;
  }

  /**
   * Applies MANY updates in ONE shot, emitting a SINGLE tasks.current snapshot (not one per task) - the
   * registry side of the bulk task_update_many tool, so the model marks/deletes a batch in one call
   * instead of N. Each entry applies independently: an unknown id fails just that entry (collected in
   * `failures`) without aborting the batch. After the batch, a completion that left every task done
   * auto-clears the checklist. <!-- 09.1 -->
   */
  updateMany(updates: readonly { readonly id: string; readonly fields: UpdateInput }[]): {
    readonly outcomes: readonly string[];
    readonly failures: readonly string[];
    readonly cleared: boolean;
  } {
    const outcomes: string[] = [];
    const failures: string[] = [];
    let completedAny = false;

    for (const u of updates) {
      try {
        const r = this.applyUpdate(u.id, u.fields);
        if (r.kind === "deleted") {
          outcomes.push(`deleted ${u.id}`);
        } else {
          outcomes.push(`${r.task.id} -> ${r.task.status}`);
          completedAny = completedAny || r.task.status === "completed";
        }
      } catch (cause) {
        failures.push(`${u.id}: ${msg(cause)}`);
      }
    }

    const cleared = completedAny && this.autoClearIfDone();
    // Only emit when something actually changed; an all-failures batch (every id unknown) is a no-op.
    if (outcomes.length > 0) {
      this.notify();
    }

    return { outcomes, failures, cleared };
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
      "Your task checklist - the single task list for this session. You own it (task_create / task_update), and it is exactly what the user sees in their task panel. Keep it current as you work - and when you change several tasks at once, do it in ONE task_update call (it takes an array of updates), not one call per task. When the user asks about tasks - what exists, what's left, what's stale, cleaning up - THIS list is the authority; read and report it directly rather than asking them to paste it:",
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

/** One task's update inside a task_update call: which task, and the fields to set on it. */
const UpdateEntry = Schema.Struct({
  taskId: Schema.String.annotations({ description: "The id of the task to update" }),
  subject: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  activeForm: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literal(...STATUS_ENUM, "deleted")),
  blockedBy: TaskIds,
  blocks: TaskIds,
});

/** task_update ALWAYS takes an array of updates (one entry per task) so a batch is a single call; a
 *  lone change is just a one-element array. */
const UpdateParams = Schema.Struct({
  updates: Schema.Array(UpdateEntry).annotations({
    description:
      "The tasks to change, ONE entry per task. Batch every change you're making into this one array - strongly prefer a single task_update with many entries over many separate task_update calls.",
  }),
});

/** task_list takes no arguments - it returns the whole current checklist. The explicit `jsonSchema`
 *  annotation is load-bearing: a bare `Schema.Struct({})` emits an `anyOf` carrying a relative `$id`
 *  URL that OpenAI-compatible providers reject (same fix as the `doctor` tool). */
const ListParams = Schema.Struct({}).annotations({
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
});

/**
 * The model-facing checklist tools: create, update, and list. The checklist is ALSO rendered into the
 * system prompt every turn ({@link TaskRegistry.renderForPrompt}), but weak local models (GLM/MiniMax)
 * reach for an explicit TOOL to enumerate rather than reading the ambient block - they call task_list
 * and, finding none, ask the user to paste the list. task_list returns the same registry on demand so
 * those models can actually see their tasks. <!-- 09.1 -->
 */
export function buildTaskTools(
  registry: TaskRegistry = taskRegistry,
): [Tool<typeof CreateParams.Type>, Tool<typeof UpdateParams.Type>, Tool<typeof ListParams.Type>] {
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
          cause instanceof TaskPreconditionError
            ? new ToolInputError({ tool: "task_create", detail: msg(cause) })
            : new ToolExecutionError({
                tool: "task_create",
                detail: msg(cause),
                cause,
              }),
      }),
  };

  const update: Tool<typeof UpdateParams.Type> = {
    name: "task_update",
    description:
      "Update one or MORE tasks on your working checklist - the single task list for this session, shown in the user's task panel. Pass `updates` as an ARRAY, one { taskId, status?, ... } per task: set status to in_progress when you start a task, completed when done, failed/cancelled if it won't be done, or deleted to retire a stale one. STRONGLY PREFER batching - when changing several tasks (marking a group completed, clearing stale ones), put them ALL in ONE call's array instead of a separate call per task. A single change is just a one-element array. Completing the last open task auto-clears the whole checklist; on a new topic, delete stale tasks and create a fresh list.",
    params: UpdateParams,
    execute: (args) =>
      Effect.try({
        try: () => {
          const { outcomes, failures, cleared } = registry.updateMany(
            args.updates.map((u) => ({
              id: u.taskId,
              fields: {
                subject: u.subject,
                description: u.description,
                activeForm: u.activeForm,
                status: u.status,
                blockedBy: ids(u.blockedBy),
                blocks: ids(u.blocks),
              },
            })),
          );

          if (cleared) {
            return "all tasks complete - checklist cleared";
          }
          const lines = [...outcomes, ...failures.map((f) => `error: ${f}`)];
          return lines.length > 0 ? lines.join("\n") : "no updates";
        },
        catch: (cause) =>
          cause instanceof TaskPreconditionError
            ? new ToolInputError({ tool: "task_update", detail: msg(cause) })
            : new ToolExecutionError({
                tool: "task_update",
                detail: msg(cause),
                cause,
              }),
      }),
  };

  const list: Tool<typeof ListParams.Type> = {
    name: "task_list",
    description:
      "List your working checklist - the single task list for this session (the one shown in the user's task panel) - returning each task's id, status, and title. This is the SAME checklist already in your prompt, returned on demand. Use it to see what exists, what's in progress, or what's stale (e.g. before cleaning up) rather than asking the user to paste it.",
    params: ListParams,
    readOnly: true,
    execute: () =>
      Effect.sync(() => {
        const tasks = registry.list();
        if (!tasks.length) {
          return "Your checklist is empty - there are no tasks.";
        }
        return tasks
          .map((t) => {
            const dep = t.blockedBy.length ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
            return `${t.id} [${STATUS_LABEL[t.status]}] ${t.activeForm}${dep}`;
          })
          .join("\n");
      }),
  };

  return [create, update, list];
}
