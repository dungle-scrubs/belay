import assert from "node:assert/strict";
import {
  decodeTrevorEvent,
  events,
  type TaskSnapshot,
  type TrevorEventInput,
  taskSnapshotReplaces,
} from "@trevor/session";
import { storedEvent } from "@trevor/test-kit";
import { Effect } from "effect";
import { test } from "vitest";
import { buildTaskTools, TaskRegistry } from "../src/tasks";

/**
 * The task checklist end to end through the host's stream wiring (plan 09 M8): the real task_create /
 * task_update tools mutate the shared registry, the same onChange -> emit the host installs publishes a
 * tasks.current per change, and each carries the registry's monotonic revision. Selecting by that
 * revision (the shared `taskSnapshotReplaces` the web `tasksFrom` and the host load guard both use)
 * yields the newest checklist and rejects a stale re-delivery - without a live model. The web-side
 * selection itself is covered by apps/web/src/derive.test.ts.
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

test("driving task_create/task_update emits revisioned tasks.current snapshots, newest wins", async () => {
  const { registry, emitted } = wireStream();
  const [create, update] = buildTaskTools(registry);

  await Effect.runPromise(create.execute({ subject: "build the parser" }));
  await Effect.runPromise(create.execute({ subject: "wire the UI" }));
  await Effect.runPromise(
    update.execute({ updates: [{ taskId: "task_1", status: "in_progress" }] }),
  );
  await Effect.runPromise(update.execute({ updates: [{ taskId: "task_1", status: "completed" }] }));

  // One snapshot per mutation, each decoding with a revision present on the wire.
  assert.equal(emitted.length, 4);
  const revs = emitted.map((input) => {
    const decoded = decodeTrevorEvent(storedEvent(input));
    assert.equal(decoded?.type, "tasks.current");
    return decoded?.type === "tasks.current" ? decoded.rev : -1;
  });
  // Revisions are monotonically increasing (the freshness ordering downstream relies on).
  assert.deepEqual(
    revs,
    [...revs].sort((a, b) => a - b),
  );
  assert.equal(new Set(revs).size, revs.length, "no two snapshots share a revision");

  // The freshest snapshot matches the live registry: task_1 completed, task_2 still pending.
  const fresh = freshestTasks(emitted);
  assert.deepEqual(
    fresh.map((t) => [t.id, t.status]),
    [
      ["task_1", "completed"],
      ["task_2", "pending"],
    ],
  );
});

test("a stale re-delivery of an earlier snapshot does not overwrite the newest state", async () => {
  const { registry, emitted } = wireStream();
  const [create, update] = buildTaskTools(registry);

  await Effect.runPromise(create.execute({ subject: "draft" }));
  const stale = emitted[0]; // the rev-1 snapshot, before the status change
  await Effect.runPromise(
    update.execute({ updates: [{ taskId: "task_1", status: "in_progress" }] }),
  );

  assert.ok(stale);
  // The stale rev-1 snapshot is replayed AFTER the rev-2 update; selection must still yield rev 2.
  const fresh = freshestTasks([...emitted, stale]);
  assert.deepEqual(
    fresh.map((t) => [t.id, t.status]),
    [["task_1", "in_progress"]],
  );
});
