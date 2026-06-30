import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TaskSnapshot } from "@trevor/session";
import { test, vi } from "vitest";
import type { SupportJob, SupportSubagent } from "./support-panel";
import { SupportPanel } from "./support-panel-view";

/**
 * M6: the responsive support panel. Interaction coverage: a job row opens its detail + can be stopped
 * while running; background overflow past the cap discloses; a subagent row has neither a detail nor a
 * kill control; an empty panel renders nothing. (The responsive two-column layout is a @container query,
 * verified visually in the deferred Storybook review.)
 */

const task = (id: string): TaskSnapshot => ({
  id,
  subject: `Task ${id}`,
  activeForm: `Doing ${id}`,
  status: "in_progress",
  blockedBy: [],
  blocks: [],
});
const job = (over: Partial<SupportJob> & { id: string }): SupportJob => ({
  command: `cmd-${over.id}`,
  status: "running",
  exitCode: null,
  ...over,
});

test("an empty panel renders nothing", () => {
  const { container } = render(<SupportPanel tasks={[]} subagents={[]} jobs={[]} />);
  assert.equal(container.firstChild, null);
});

test("a running job row opens its detail and can be stopped", () => {
  const onOpenJobDetail = vi.fn();
  const onKillJob = vi.fn();
  render(
    <SupportPanel
      tasks={[]}
      subagents={[]}
      jobs={[job({ id: "p1" })]}
      onOpenJobDetail={onOpenJobDetail}
      onKillJob={onKillJob}
    />,
  );
  fireEvent.click(screen.getByLabelText("Inspect p1"));
  assert.deepEqual(onOpenJobDetail.mock.calls, [["p1"]]);
  fireEvent.click(screen.getByLabelText("Stop p1"));
  assert.deepEqual(onKillJob.mock.calls, [["p1"]]);
});

test("a finished job has no stop control (only detail)", () => {
  render(
    <SupportPanel
      tasks={[]}
      subagents={[]}
      jobs={[job({ id: "p2", status: "exited", exitCode: 0 })]}
      onOpenJobDetail={vi.fn()}
      onKillJob={vi.fn()}
    />,
  );
  assert.ok(screen.getByLabelText("Inspect p2"));
  assert.equal(screen.queryByLabelText("Stop p2"), null);
});

test("a subagent row has neither a detail nor a kill control", () => {
  const sub: SupportSubagent = { id: "s1", agent: "explorer", task: "t", status: "running" };
  render(
    <SupportPanel
      tasks={[]}
      subagents={[sub]}
      jobs={[]}
      onOpenJobDetail={vi.fn()}
      onKillJob={vi.fn()}
    />,
  );
  assert.ok(screen.getByText("explorer"));
  assert.equal(screen.queryByLabelText("Inspect s1"), null);
  assert.equal(screen.queryByLabelText("Stop s1"), null);
});

test("background overflow past the cap discloses with a toggle", () => {
  const jobs = Array.from({ length: 8 }, (_, i) => job({ id: `p${i}` }));
  render(<SupportPanel tasks={[]} subagents={[]} jobs={jobs} onOpenJobDetail={vi.fn()} />);
  // 5 visible + a "…3 more" toggle; the 8th row is hidden until expanded.
  assert.equal(screen.queryByText("cmd-p7"), null);
  fireEvent.click(screen.getByText("…3 more"));
  assert.ok(screen.getByText("cmd-p7"), "all rows shown after disclosure");
});

test("both sections present: tasks + background both render", () => {
  render(
    <SupportPanel
      tasks={[task("a")]}
      subagents={[]}
      jobs={[job({ id: "p1" })]}
      onOpenJobDetail={vi.fn()}
    />,
  );
  assert.ok(screen.getByText("Doing a"), "the task row renders (via TasksPanel)");
  assert.ok(screen.getByText("cmd-p1"), "the job row renders");
});
