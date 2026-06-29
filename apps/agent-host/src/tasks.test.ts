import assert from "node:assert/strict";
import type { TaskSnapshot, TaskStatus } from "@trevor/session";
import { test } from "vitest";
import { contextRegistry } from "./context/registry";
import { SystemPromptBuilder } from "./providers/system-prompt";
import { TaskRegistry } from "./tasks";

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

  assert.match(prompt, /Your current task checklist/);
  assert.match(prompt, /\[in progress\] task_1: wiring the API/);
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
