import assert from "node:assert/strict";
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
