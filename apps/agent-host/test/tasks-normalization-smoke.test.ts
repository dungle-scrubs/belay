import assert from "node:assert/strict";
import {
  decodeTrevorEvent,
  events,
  type TaskSnapshot,
  type TrevorEventInput,
  taskSnapshotReplaces,
} from "@belay/session";
import { storedEvent } from "@belay/test-kit";
import { buildTaskTools, TaskRegistry } from "@host/tools/tasks/tasks";
import { Effect } from "effect";
import { test } from "vitest";

/**
 * Smoke coverage for task-id NORMALIZATION (09.1), driven end to end through the REAL task_create /
 * task_update tools and the host's onChange -> tasks.current stream wiring (no live model).
 *
 * This is the drift canary the owner asked for. The bug: local models (GLM-5.2, MiniMax) call
 * task_update with the BARE number ("36" for task_36); a strict id match rejected those as
 * `no such task`, so the model's progress updates silently failed and the checklist froze stale.
 * `ID_FORMS` pins every id shape a model is known to send - if normalization ever regresses, or a new
 * model surfaces a new shape we don't accept, the matching row fails here instead of in production.
 * Mirrors the harness in tasks-stream.test.ts. <!-- 09.1 -->
 */

/** Mirrors main.ts: every registry mutation publishes a revisioned tasks.current snapshot. */
function wireStream(): { registry: TaskRegistry; emitted: TrevorEventInput[] } {
  const registry = new TaskRegistry();
  const emitted: TrevorEventInput[] = [];

  registry.onChange(() => {
    emitted.push(events.tasksCurrent({ tasks: registry.snapshot(), rev: registry.revision() }));
  });

  return { registry, emitted };
}

/** Folds an event stream the way a consumer does: the freshest valid tasks.current wins (D-004). */
function freshestTasks(stream: readonly TrevorEventInput[]): readonly TaskSnapshot[] {
  let bestRev = Number.NEGATIVE_INFINITY;
  let best: readonly TaskSnapshot[] = [];

  stream.forEach((input, index) => {
    const decoded = decodeTrevorEvent(storedEvent(input, { seq: index + 1 }));

    if (decoded?.type === "tasks.current" && taskSnapshotReplaces(decoded.rev, bestRev)) {
      bestRev = decoded.rev;
      best = decoded.tasks;
    }
  });

  return best;
}

const statusOf = (tasks: readonly TaskSnapshot[], id: string): string | undefined =>
  tasks.find((t) => t.id === id)?.status;

test("the exact event-log repro: a bare '36' advances task_36, not 'no such task'", async () => {
  const { registry, emitted } = wireStream();
  const [create, update] = buildTaskTools(registry);

  // Mint task_1 .. task_36 the way the source-recall audit plan did.
  for (let i = 1; i <= 36; i += 1) {
    await Effect.runPromise(create.execute({ subject: `step ${i}` }));
  }

  // The model sends the BARE number, exactly as captured in the event log:
  //   {"taskId":"36","status":"in_progress"}  ->  previously: error no such task "36".
  const result = await Effect.runPromise(
    update.execute({ updates: [{ taskId: "36", status: "in_progress" }] }),
  );
  assert.match(
    result,
    /task_36 -> in_progress/,
    "the bare id resolves to task_36 and the call lands",
  );

  assert.equal(
    statusOf(freshestTasks(emitted), "task_36"),
    "in_progress",
    "the emitted snapshot reflects the update (the checklist no longer freezes stale)",
  );
});

// Every id shape a model is known to send, and the canonical task it must resolve to. Add a row when a
// new model variant surfaces a new shape - a regression in normalization fails the matching row.
const ID_FORMS: ReadonlyArray<{ readonly sent: string; readonly resolvesTo: string }> = [
  { sent: "task_1", resolvesTo: "task_1" }, // canonical, as rendered in the prompt
  { sent: "1", resolvesTo: "task_1" }, // bare number (the GLM/MiniMax shape that caused the bug)
  { sent: "task_2", resolvesTo: "task_2" },
  { sent: " 2 ", resolvesTo: "task_2" }, // stray surrounding whitespace
];

test.each(ID_FORMS)(
  "task_update tolerates id form $sent -> $resolvesTo",
  async ({ sent, resolvesTo }) => {
    const { registry, emitted } = wireStream();
    const [create, update] = buildTaskTools(registry);
    await Effect.runPromise(create.execute({ subject: "a" })); // task_1
    await Effect.runPromise(create.execute({ subject: "b" })); // task_2

    await Effect.runPromise(update.execute({ updates: [{ taskId: sent, status: "completed" }] }));

    assert.equal(statusOf(freshestTasks(emitted), resolvesTo), "completed");
  },
);

test("a genuinely unknown id is reported as a per-entry failure and emits nothing (never over-matches)", async () => {
  const { registry, emitted } = wireStream();
  const [create, update] = buildTaskTools(registry);
  await Effect.runPromise(create.execute({ subject: "only" })); // task_1
  const before = emitted.length;

  // Both ids are unknown: the batch reports each as a failure (no over-match) and changes nothing.
  const out = await Effect.runPromise(
    update.execute({
      updates: [
        { taskId: "999", status: "completed" },
        { taskId: "task_999", status: "completed" },
      ],
    }),
  );

  assert.match(out, /error: 999/);
  assert.match(out, /error: task_999/);
  assert.equal(
    emitted.length,
    before,
    "an all-failures batch mutates nothing and emits no snapshot",
  );
});

test("the dismiss control (registry.clear) emits one empty snapshot so the panel hides", async () => {
  const { registry, emitted } = wireStream();
  const [create] = buildTaskTools(registry);
  await Effect.runPromise(create.execute({ subject: "a" }));
  await Effect.runPromise(create.execute({ subject: "b", status: "in_progress" }));
  const before = emitted.length;

  const dropped = registry.clear();

  assert.equal(dropped, 2, "every task is dropped");
  assert.equal(emitted.length, before + 1, "exactly one snapshot is emitted for the clear");
  assert.deepEqual(freshestTasks(emitted), [], "the freshest snapshot is empty -> the panel hides");
});
