import assert from "node:assert/strict";
import type { TaskSnapshot } from "@trevor/session";
import { test } from "vitest";
import { buildSupportPanel, type SupportJob, type SupportSubagent } from "./support-panel";

/**
 * M5: the pure support-panel projection. Sections: tasks only / background only / both / empty; in the
 * background group, subagents come before jobs; rows carry status labels, tone, and detail eligibility
 * (jobs open the detail takeover; subagents do not).
 */

const task = (id: string): TaskSnapshot => ({
  id,
  subject: `Task ${id}`,
  activeForm: `Doing ${id}`,
  status: "in_progress",
  blockedBy: [],
  blocks: [],
});
const subagent = (id: string): SupportSubagent => ({
  id,
  agent: `agent-${id}`,
  task: "t",
  status: "running",
});
const job = (over: Partial<SupportJob> & { id: string }): SupportJob => ({
  command: "sleep 9",
  status: "running",
  exitCode: null,
  ...over,
});

test("empty input yields empty sections and no two-column", () => {
  const p = buildSupportPanel({ tasks: [], subagents: [], jobs: [] });
  assert.deepEqual([p.hasTasks, p.hasBackground, p.twoColumn], [false, false, false]);
});

test("tasks only: a tasks section, no background, no two-column", () => {
  const p = buildSupportPanel({ tasks: [task("a")], subagents: [], jobs: [] });
  assert.deepEqual([p.hasTasks, p.hasBackground, p.twoColumn], [true, false, false]);
  assert.equal(p.tasks[0]?.title, "Task a");
});

test("background only (subagents): no tasks, no two-column", () => {
  const p = buildSupportPanel({ tasks: [], subagents: [subagent("s")], jobs: [] });
  assert.deepEqual([p.hasTasks, p.hasBackground, p.twoColumn], [false, true, false]);
});

test("jobs only: a background job row, detail-eligible", () => {
  const p = buildSupportPanel({ tasks: [], subagents: [], jobs: [job({ id: "p1" })] });
  assert.equal(p.background[0]?.kind, "job");
  assert.equal(p.background[0]?.detailEligible, true);
  assert.equal(p.background[0]?.label, "sleep 9");
});

test("tasks + background present: twoColumn is true", () => {
  const p = buildSupportPanel({ tasks: [task("a")], subagents: [], jobs: [job({ id: "p1" })] });
  assert.equal(p.twoColumn, true);
});

test("subagents render BEFORE jobs in the background group", () => {
  const p = buildSupportPanel({
    tasks: [],
    subagents: [subagent("s1")],
    jobs: [job({ id: "p1" })],
  });
  assert.deepEqual(
    p.background.map((r) => r.kind),
    ["subagent", "job"],
  );
});

test("job status -> tone + label: running / done (exit 0) / killed / non-zero exit", () => {
  const rows = buildSupportPanel({
    tasks: [],
    subagents: [],
    jobs: [
      job({ id: "p1", status: "running" }),
      job({ id: "p2", status: "exited", exitCode: 0 }),
      job({ id: "p3", status: "killed" }),
      job({ id: "p4", status: "exited", exitCode: 2 }),
    ],
  }).background;
  assert.deepEqual(
    rows.map((r) => [r.tone, r.statusLabel]),
    [
      ["running", "running"],
      ["done", "done"],
      ["error", "killed"],
      ["error", "exit 2"],
    ],
  );
});

test("a subagent row is NOT detail-eligible and tones by status", () => {
  const [running, done, failed] = buildSupportPanel({
    tasks: [],
    subagents: [
      { id: "a", agent: "x", task: "t", status: "running" },
      { id: "b", agent: "y", task: "t", status: "done" },
      { id: "c", agent: "z", task: "t", status: "failed" },
    ],
    jobs: [],
  }).background;
  assert.equal(running?.detailEligible, false);
  assert.deepEqual([running?.tone, done?.tone, failed?.tone], ["running", "done", "error"]);
});
