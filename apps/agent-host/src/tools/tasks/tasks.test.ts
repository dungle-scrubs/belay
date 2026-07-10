import assert from "node:assert/strict";
import { contextRegistry } from "@host/project-context/registry";
import { SystemPromptBuilder } from "@host/providers/system-prompt";
import type { TaskSnapshot, TaskStatus } from "@trevor/session";
import { Effect } from "effect";
import { test } from "vitest";
import { buildTaskTools, TaskRegistry } from "./tasks";

/**
 * The task registry is the live, model-owned checklist (apps/agent-host/src/tasks.ts). These
 * pin the two properties the UI freshness work (plan 09) must not regress: the system prompt
 * always renders the COMPLETE registry at build time (D-001/D-006), independent of any UI-side
 * truncation, and the registry carries monotonic freshness metadata so a stale snapshot can
 * never overwrite newer state (D-004).
 */

const TOOLS = [{ name: "edit", description: "Edit a file.", parameters: {} }];

/** A builder wired to a fresh task registry and an empty context registry (no AGENTS.md block). */
function promptFor(registry: TaskRegistry): string {
  contextRegistry.reset();
  return new SystemPromptBuilder(contextRegistry, registry).build(TOOLS, {
    workspaceRoot: "/ws",
    cwd: "/ws",
  });
}

// --- M1: prompt registry awareness (D-006) ---

test("a task created before the prompt build appears in the rendered system prompt", () => {
  const registry = new TaskRegistry();
  registry.create({ subject: "wire the API", activeForm: "wiring the API", status: "in_progress" });

  const prompt = promptFor(registry);

  assert.match(prompt, /Your task checklist/);
  assert.match(prompt, /\[in progress\] task_1: wiring the API/);
});

test("the checklist prompt frames itself as the single, user-visible task list (09.1)", () => {
  // The framing must tie the checklist to ONE canonical list (the task tools + the user's panel) so a
  // model treats it as the authority when asked about tasks - and must NOT dissociate it from the user
  // (the old "this is your plan, not the user's" made MiniMax ask the user to paste the list instead).
  const registry = new TaskRegistry();
  registry.create({ subject: "do the thing" });

  const prompt = promptFor(registry);

  assert.match(prompt, /single task list for this session/);
  assert.match(prompt, /task panel/, "ties the checklist to what the user sees");
  assert.doesNotMatch(
    prompt,
    /not the user's/,
    "no longer dissociates the checklist from the user",
  );
});

test("the task tool descriptions name the single canonical list (so a tool-first model converges on it)", () => {
  // Co-locating the identity at the tool level (not just the prompt block) means a model that reads
  // tool descriptions over the ambient prompt still routes to the one list shown in the user's panel.
  const [create, update] = buildTaskTools(new TaskRegistry());
  for (const tool of [create, update]) {
    assert.match(tool.description, /single task list for this session/);
    assert.match(tool.description, /task panel/);
  }
});

test("task_list returns the current checklist so a tool-first model can enumerate it (09.1)", async () => {
  // MiniMax/GLM call task_list expecting a tool; without one they ask the user to paste the list even
  // though the same tasks are in their prompt. task_list returns the live registry on demand.
  const registry = new TaskRegistry();
  registry.create({ subject: "first", activeForm: "doing first", status: "in_progress" });
  registry.create({ subject: "second" });
  const [, , list] = buildTaskTools(registry);

  const out = await Effect.runPromise(list.execute({}));

  assert.match(out, /task_1 \[in progress\] doing first/);
  assert.match(out, /task_2 \[pending\] second/);
});

test("task_list on an empty checklist says so plainly (not an error)", async () => {
  const [, , list] = buildTaskTools(new TaskRegistry());
  assert.equal(
    await Effect.runPromise(list.execute({})),
    "Your checklist is empty - there are no tasks.",
  );
});

test("task_update takes an array: one call updates many tasks and emits ONE snapshot (09.1)", async () => {
  const registry = new TaskRegistry();
  let emits = 0;
  registry.onChange(() => {
    emits += 1;
  });
  registry.create({ subject: "a" }); // task_1
  registry.create({ subject: "b" }); // task_2
  registry.create({ subject: "c" }); // task_3
  const [, update] = buildTaskTools(registry);
  emits = 0;

  const out = await Effect.runPromise(
    update.execute({
      updates: [
        { taskId: "1", status: "completed" }, // bare id tolerated inside the batch too
        { taskId: "task_2", status: "in_progress" },
        { taskId: "3", status: "deleted" },
      ],
    }),
  );

  assert.equal(emits, 1, "the whole batch emits exactly one snapshot, not one per task");
  assert.match(out, /task_1 -> completed/);
  assert.match(out, /task_2 -> in_progress/);
  assert.match(out, /deleted 3/);
  assert.deepEqual(
    registry.list().map((t) => [t.id, t.status]),
    [
      ["task_1", "completed"],
      ["task_2", "in_progress"],
    ],
    "task_3 was deleted in the same call",
  );
});

test("task_update with a one-element array is just a single update", async () => {
  const registry = new TaskRegistry();
  registry.create({ subject: "x" }); // task_1
  const [, update] = buildTaskTools(registry);

  // Completing the only task auto-clears, exactly like the old single-update path.
  assert.match(
    await Effect.runPromise(update.execute({ updates: [{ taskId: "1", status: "completed" }] })),
    /checklist cleared/,
  );
});

test("task_update description steers toward batching (prefer one call over many) (09.1)", () => {
  const [, update] = buildTaskTools(new TaskRegistry());
  assert.match(update.description, /array/i);
  assert.match(update.description, /prefer batching/i);
});

test("a task updated before the prompt build is rendered at its new status", () => {
  const registry = new TaskRegistry();
  const task = registry.create({ subject: "ship it", activeForm: "shipping it" });
  registry.update(task.id, { status: "in_progress" });

  const prompt = promptFor(registry);

  assert.match(prompt, /\[in progress\] task_1: shipping it/);
});

// --- M1: the prompt is built from the COMPLETE registry, never a UI-truncated view (D-001) ---

test("the prompt checklist includes every task even past the UI's five-row cap", () => {
  const registry = new TaskRegistry();
  for (let i = 1; i <= 9; i += 1) {
    registry.create({ subject: `task ${i}`, activeForm: `doing ${i}` });
  }

  const prompt = registry.renderForPrompt();

  // All nine tasks render, so a UI that shows only five rows cannot starve the model's plan.
  for (let i = 1; i <= 9; i += 1) {
    assert.match(prompt, new RegExp(`task_${i}: doing ${i}`));
  }
  assert.equal(prompt.split("\n").length, 10); // the header line plus nine task rows
});

// --- M5/M6: registry freshness metadata + the standby/replay load guard (D-004) ---

const snap = (id: string, status: TaskStatus): TaskSnapshot => ({
  id,
  subject: id,
  activeForm: id,
  status,
  blockedBy: [],
  blocks: [],
});

test("the registry revision increases monotonically on every mutation", () => {
  const registry = new TaskRegistry();
  assert.equal(registry.revision(), 0);

  const task = registry.create({ subject: "a" });
  assert.equal(registry.revision(), 1);

  registry.update(task.id, { status: "in_progress" });
  assert.equal(registry.revision(), 2);

  registry.update(task.id, { status: "deleted" });
  assert.equal(registry.revision(), 3);
});

test("loadIfFresh ignores a stale snapshot and keeps the newer state", () => {
  const registry = new TaskRegistry();

  assert.equal(registry.loadIfFresh([snap("task_1", "in_progress")], 5), true);
  assert.equal(registry.revision(), 5);

  // An older snapshot (lower revision) arrives late; it must not clobber the rev-5 state.
  assert.equal(registry.loadIfFresh([snap("task_2", "pending")], 2), false);
  assert.deepEqual(
    registry.list().map((t) => t.id),
    ["task_1"],
  );
  assert.equal(registry.revision(), 5);
});

test("loadIfFresh applies an equal revision so an ordered (legacy) replay ends on the latest", () => {
  const registry = new TaskRegistry();

  // Legacy snapshots all share revision 0; the latest in replay order still wins.
  assert.equal(registry.loadIfFresh([snap("task_1", "pending")], 0), true);
  assert.equal(registry.loadIfFresh([snap("task_2", "in_progress")], 0), true);
  assert.deepEqual(
    registry.list().map((t) => t.id),
    ["task_2"],
  );
});

test("a live leader's newer registry state survives a stale read-back of its own snapshot", () => {
  const registry = new TaskRegistry();

  // The leader mutates its registry directly (rev climbs to 2)...
  const task = registry.create({ subject: "wire" });
  registry.update(task.id, { status: "in_progress" });
  assert.equal(registry.revision(), 2);

  // ...then an older snapshot it emitted earlier (rev 1) is read back; freshness rejects it, so the
  // in_progress edit is preserved even if the leader-ownership skip were ever bypassed.
  assert.equal(registry.loadIfFresh([snap("task_1", "pending")], 1), false);
  assert.equal(registry.list()[0]?.status, "in_progress");
});

test("loadIfFresh adopts the snapshot revision so later mutations stay monotonic", () => {
  const registry = new TaskRegistry();

  registry.loadIfFresh([snap("task_1", "pending")], 9);
  assert.equal(registry.revision(), 9);

  // A standby promoted to leader continues bumping from the adopted revision, never rewinding.
  const next = registry.create({ subject: "next" });
  assert.equal(registry.revision(), 10);
  assert.equal(next.id, "task_2"); // the seq id allocator also advanced past the loaded task_1
});

// --- 09.1: tolerant task-id resolution (the real bug behind the stale checklists) ---
//
// The registry stores ids as `task_<n>` and shows them that way in the prompt, but local models
// (GLM-5.2, MiniMax) routinely call task_update with the BARE number ("36" for task_36). A strict
// `Map.get` rejected those as `no such task`, so the model's progress updates silently failed and the
// checklist froze stale. resolveId() now accepts both forms; a genuinely unknown id still errors.

test("task_update tolerates a bare numeric id (the `task_` prefix is optional)", () => {
  const registry = new TaskRegistry();
  registry.create({ subject: "review security" }); // -> task_1

  // The exact call shape observed in the event log: {"taskId":"1","status":"in_progress"}.
  const result = registry.update("1", { status: "in_progress" });

  assert.equal(result.kind, "updated");
  assert.equal(registry.list()[0]?.status, "in_progress");
});

test("task_update still accepts the canonical `task_<n>` id", () => {
  const registry = new TaskRegistry();
  registry.create({ subject: "ship" }); // task_1

  // Completing the only task auto-clears the finished checklist (unchanged behavior).
  assert.equal(registry.update("task_1", { status: "completed" }).kind, "cleared");
  assert.equal(registry.list().length, 0);
});

test("a bare id deletes the right task", () => {
  const registry = new TaskRegistry();
  registry.create({ subject: "a" }); // task_1
  registry.create({ subject: "b" }); // task_2

  assert.equal(registry.update("2", { status: "deleted" }).kind, "deleted");
  assert.deepEqual(
    registry.list().map((t) => t.id),
    ["task_1"],
  );
});

test("a genuinely unknown id still surfaces as not-found (the raw id is echoed back)", () => {
  const registry = new TaskRegistry();
  registry.create({ subject: "only" }); // task_1

  assert.throws(() => registry.update("99", { status: "completed" }), /no such task "99"/);
  assert.throws(
    () => registry.update("task_99", { status: "completed" }),
    /no such task "task_99"/,
  );
});

test("resolveId maps a bare number to its canonical task id, else undefined", () => {
  const registry = new TaskRegistry();
  registry.create({ subject: "x" }); // task_1

  assert.equal(registry.resolveId("1"), "task_1");
  assert.equal(registry.resolveId("task_1"), "task_1");
  assert.equal(registry.resolveId(" 1 "), "task_1"); // trims stray whitespace
  assert.equal(registry.resolveId("2"), undefined);
});

test("blockedBy accepts a bare id so a dependency gate still resolves", () => {
  const registry = new TaskRegistry();
  registry.create({ subject: "blocker" }); // task_1 (pending)
  registry.create({ subject: "blocked", blockedBy: ["1"] }); // task_2 blocked by the bare "1"

  // The blocker is still pending, so starting task_2 (referencing it as "1") must be refused.
  assert.throws(() => registry.update("2", { status: "in_progress" }), /blocked by/);

  // Once the blocker completes, the gate opens.
  registry.update("1", { status: "completed" });
  assert.equal(registry.update("2", { status: "in_progress" }).kind, "updated");
});

// --- 09.1: user-initiated clear (the dismiss control's safety net for an abandoned checklist) ---

test("clear() retires the whole checklist and emits one empty snapshot", () => {
  const registry = new TaskRegistry();
  let emits = 0;
  registry.onChange(() => {
    emits += 1;
  });
  registry.create({ subject: "a" });
  registry.create({ subject: "b", status: "in_progress" });
  const revBefore = registry.revision();
  emits = 0;

  const dropped = registry.clear();

  assert.equal(dropped, 2, "reports how many tasks were dropped");
  assert.equal(registry.list().length, 0, "the checklist is empty");
  assert.equal(emits, 1, "exactly one snapshot is emitted (the empty one)");
  assert.ok(registry.revision() > revBefore, "the freshness revision advances so clients converge");
});

test("clear() on an already-empty checklist is a no-op (no emit, no rev bump)", () => {
  const registry = new TaskRegistry();
  let emits = 0;
  registry.onChange(() => {
    emits += 1;
  });
  const revBefore = registry.revision();

  assert.equal(registry.clear(), 0);
  assert.equal(emits, 0, "no listeners fired");
  assert.equal(registry.revision(), revBefore, "revision unchanged");
});

test("task_create maps registry precondition failures to ToolInputError, not ToolExecutionError", async () => {
  // "subject is required" / "blocked by" are bad-call failures (the model's arguments), so they
  // belong to the taxonomy's input class; ToolExecutionError stays reserved for a delegated
  // operation breaking.
  const [create] = buildTaskTools(new TaskRegistry());
  const blank = await Effect.runPromise(Effect.flip(create.execute({ subject: "   " })));
  assert.equal(blank._tag, "ToolInputError");
  assert.match(blank.detail, /subject is required/);

  const registry = new TaskRegistry();
  registry.create({ subject: "blocker" }); // task_1, pending
  const [createBlocked] = buildTaskTools(registry);
  const blocked = await Effect.runPromise(
    Effect.flip(
      createBlocked.execute({ subject: "dependent", status: "in_progress", blockedBy: ["1"] }),
    ),
  );
  assert.equal(blocked._tag, "ToolInputError");
  assert.match(blocked.detail, /blocked by 1 \(pending\)/);
});
