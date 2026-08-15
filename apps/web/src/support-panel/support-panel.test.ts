import assert from "node:assert/strict";
import type { JobSnapshot, TaskSnapshot } from "@belay/session";
import { test } from "vitest";
import type { Message } from "@/transcript";
import {
  buildSupportPanel,
  jobOutcome,
  jobToDetailModel,
  runningSubagents,
  type SupportSubagent,
} from "./support-panel";

const job = (over: Partial<JobSnapshot> & { id: string }): JobSnapshot => ({
  command: "sleep 9",
  source: "bash",
  cwd: "/work",
  startedAt: 1,
  status: "running",
  exitCode: null,
  stdoutTotal: 0,
  stderrTotal: 0,
  ...over,
});

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

test("terminal job rows expose dismiss while running jobs do not", () => {
  const rows = buildSupportPanel({
    tasks: [],
    subagents: [],
    jobs: [
      job({ id: "p1", status: "running" }),
      job({ id: "p2", status: "exited", exitCode: 0 }),
      job({ id: "p3", status: "killed" }),
      { ...job({ id: "p4", status: "running" }), interrupted: true },
    ],
  }).background;

  assert.deepEqual(
    rows.map((row) => row.dismissEligible),
    [false, true, true, false],
  );
});

test("jobOutcome resolves the terminal disposition the row + detail both key off (incl. null exit)", () => {
  assert.equal(jobOutcome(job({ id: "a", status: "running" })), "running");
  assert.equal(jobOutcome(job({ id: "b", status: "exited", exitCode: 0 })), "done");
  assert.equal(jobOutcome(job({ id: "c", status: "exited", exitCode: 2 })), "error");
  assert.equal(jobOutcome(job({ id: "d", status: "killed" })), "error");
  // A clean exit with no numeric code is done, not an error - the row tone + the detail status must agree
  // here (they previously disagreed: the row read null as error, the detail read it as done).
  assert.equal(jobOutcome(job({ id: "e", status: "exited", exitCode: null })), "done");
  // D-003: an interrupted (orphan-reconciled) job is terminal (error tone) even though its raw lifecycle
  // is still "running" - its owning host is gone.
  assert.equal(jobOutcome({ ...job({ id: "f", status: "running" }), interrupted: true }), "error");
});

test("D-003: jobToDetailModel reflects an interrupted job as terminal with a recovered error note", () => {
  const model = jobToDetailModel({
    ...job({ id: "p1", command: "pnpm dev", status: "running", tail: "compiling..." }),
    interrupted: true,
  });
  assert.equal(model.status, "error", "the detail takeover shows a terminal status, not running");
  assert.equal(model.aborted, false, "not a user kill - it was recovered");
  assert.match(model.error ?? "", /host/, "the note explains the owning host went away");
  assert.equal(model.output, "compiling...", "the bounded tail is still shown");
});

test("runningSubagents keeps only non-terminal BACKGROUND rows; inline is excluded (M7 / 09.4 M4)", () => {
  const messages: Message[] = [
    {
      kind: "delegation",
      id: "d1",
      childSessionId: "c1",
      agent: "explorer",
      task: "scan",
      mode: "background",
      status: "running",
    },
    {
      kind: "delegation",
      id: "d2",
      childSessionId: "c2",
      agent: "reviewer",
      task: "review",
      mode: "background",
      status: "done",
    },
    // A blocking `delegate_inline` agent renders as an inlineAgent MESSAGE (a different kind), so the
    // transcript reducer already split it out and it never reaches this panel (09.4 M3/M4).
    {
      kind: "inlineAgent",
      id: "ia1",
      parentRunId: "r1",
      agents: [{ childSessionId: "c3", agent: "planner", status: "running" }],
    },
    { kind: "user", id: "u1", text: "hi", artifacts: [], pastes: [] },
  ];
  assert.deepEqual(
    runningSubagents(messages).map((s) => s.agent),
    ["explorer"],
    "only the running background child; the done one and the inline-agent message are excluded",
  );
});

test("jobToDetailModel opens the shared tool-detail with command/cwd as args + the tail as output (M8)", () => {
  const m = jobToDetailModel(job({ id: "p1", command: "pnpm dev", tail: "compiled\nwatching..." }));
  assert.equal(m.id, "p1");
  assert.equal(m.toolName, "bash", "renders via the bash detail body (command + cwd + output)");
  assert.equal(m.status, "running");
  assert.deepEqual(JSON.parse(m.args), { command: "pnpm dev", cwd: "/work" });
  assert.equal(m.output, "compiled\nwatching...");
});

test("jobToDetailModel maps status: a killed job is aborted/error, a non-zero exit is error (M8)", () => {
  const killed = jobToDetailModel(job({ id: "p2", status: "killed" }));
  assert.equal(killed.status, "error");
  assert.equal(killed.aborted, true);
  assert.equal(killed.error, "stopped");
  const failed = jobToDetailModel(job({ id: "p3", status: "exited", exitCode: 2 }));
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /code 2/);
  const done = jobToDetailModel(job({ id: "p4", status: "exited", exitCode: 0 }));
  assert.equal(done.status, "done");
  assert.equal(done.error, undefined);
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

test("D-002: runningSubagents excludes an interrupted child (terminal like done/failed)", () => {
  const messages: Message[] = [
    {
      kind: "delegation",
      id: "d1",
      childSessionId: "c1",
      agent: "explorer",
      task: "scan",
      mode: "background",
      status: "interrupted",
    },
    {
      kind: "delegation",
      id: "d2",
      childSessionId: "c2",
      agent: "reviewer",
      task: "review",
      mode: "background",
      status: "running",
    },
  ];
  assert.deepEqual(
    runningSubagents(messages).map((s) => s.agent),
    ["reviewer"],
    "an interrupted child drops out of background work; only the running one remains",
  );
});

test("D-002: an interrupted subagent row tones error/terminal but keeps its own 'interrupted' label", () => {
  const [row] = buildSupportPanel({
    tasks: [],
    subagents: [{ id: "a", agent: "explorer", task: "t", status: "interrupted" }],
    jobs: [],
  }).background;
  assert.equal(row?.tone, "error", "shares the terminal tone the turn's interrupted note uses");
  assert.equal(
    row?.statusLabel,
    "interrupted",
    "labeled interrupted, not failed - it was recovered",
  );
});

test("M5: after reconcile, an orphaned subagent + a dead-host job settle to no RUNNING background work", () => {
  // The whole orphaned-background picture after both reconciles: the subagent was reaped to interrupted
  // (runningSubagents already dropped it, so the app would not even pass it here), and the dead host's
  // running job carries the derive-layer interrupted flag (D-003). No background row is left "running".
  const panel = buildSupportPanel({
    tasks: [],
    subagents: [], // the orphaned child dropped out of runningSubagents once interrupted
    jobs: [{ ...job({ id: "p1", status: "running" }), interrupted: true }],
  });
  assert.equal(
    panel.hasBackground,
    true,
    "the reconciled rows still show (terminal), just not running",
  );
  assert.ok(
    panel.background.every((row) => row.tone !== "running"),
    "nothing renders as running once the owning host is gone",
  );
  const jobRow = panel.background.find((r) => r.kind === "job");
  assert.equal(jobRow?.tone, "error");
  assert.equal(jobRow?.statusLabel, "interrupted");
});
