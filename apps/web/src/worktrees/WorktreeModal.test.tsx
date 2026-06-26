import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeSummary } from "@trevor/session";
import { test, vi } from "vitest";
import { WorktreeModal } from "./WorktreeModal";
import type { WorktreeRowsContext } from "./worktree-rows";

const wt = (over: Partial<WorktreeSummary>): WorktreeSummary => ({
  id: "wt",
  baseRepo: "/dev/trevorV2",
  baseRepoName: "trevorV2",
  branch: "feat/x",
  path: "~/.worktrees/h/feat-x-wt",
  sessionId: "s-wt",
  dirty: false,
  ahead: 0,
  behind: 0,
  conflict: false,
  detached: false,
  current: false,
  baseline: false,
  missing: false,
  ...over,
});

const worktrees: WorktreeSummary[] = [
  wt({ id: "baseline", branch: "main", baseline: true, current: true }),
  wt({ id: "a", branch: "feat/sidebar" }),
  wt({ id: "gone", branch: "chore/gone", missing: true }),
];

function renderModal(over: Partial<React.ComponentProps<typeof WorktreeModal>> = {}) {
  const onSwitch = vi.fn();
  const onOpenChange = vi.fn();
  const context: WorktreeRowsContext = { busy: false };
  render(
    <WorktreeModal
      open
      onOpenChange={onOpenChange}
      worktrees={worktrees}
      context={context}
      onSwitch={onSwitch}
      {...over}
    />,
  );
  return { onSwitch, onOpenChange };
}

test("renders the baseline + worktree branches grouped by base repo", () => {
  renderModal();
  assert.ok(screen.getByText("main (baseline)"));
  assert.ok(screen.getByText("feat/sidebar"));
  assert.ok(screen.getByText("trevorV2")); // base-repo group heading
});

test("switching to a worktree fires onSwitch with its id and closes", () => {
  const { onSwitch, onOpenChange } = renderModal();
  fireEvent.click(screen.getByText("feat/sidebar"));
  assert.deepEqual(onSwitch.mock.calls, [["a"]]);
  assert.deepEqual(onOpenChange.mock.calls.at(-1), [false]);
});

test("the current worktree is disabled and never switches", () => {
  const { onSwitch } = renderModal();
  fireEvent.click(screen.getByText("main (baseline)"));
  assert.equal(onSwitch.mock.calls.length, 0);
  assert.ok(screen.getByText("current worktree"));
});

test("a missing worktree shows the repair reason and never switches", () => {
  const { onSwitch } = renderModal();
  fireEvent.click(screen.getByText("chore/gone"));
  assert.equal(onSwitch.mock.calls.length, 0);
  assert.ok(screen.getByText("missing — needs repair"));
});

test("while busy, switching to another worktree is blocked", () => {
  const { onSwitch } = renderModal({ context: { busy: true } });
  fireEvent.click(screen.getByText("feat/sidebar"));
  assert.equal(onSwitch.mock.calls.length, 0);
});

test("an empty worktree set shows the empty state", () => {
  renderModal({ worktrees: [] });
  assert.ok(screen.getByText("No worktrees"));
});
