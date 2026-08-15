import assert from "node:assert/strict";
import type { GitStatus } from "@belay/session";
import { fireEvent, render } from "@testing-library/react";
import { test } from "vitest";
import { gitLine, WorkspaceIdentity } from "./workspace-identity";

const base: GitStatus = {
  branch: "main",
  detached: null,
  dirty: false,
  ahead: 0,
  behind: 0,
  upstream: true,
  worktree: false,
};

test("gitLine projects a clean branch with no dirty marker and no arrows", () => {
  const line = gitLine(base);
  assert.deepEqual(line, { ref: "main", detached: false, dirty: false, ahead: 0, behind: 0 });
});

test("gitLine labels a detached HEAD by its short commit", () => {
  const line = gitLine({ ...base, branch: null, detached: "a1b2c3d" });
  assert.equal(line?.ref, "detached a1b2c3d");
  assert.equal(line?.detached, true);
});

test("gitLine returns null when there is no branch and no commit", () => {
  assert.equal(gitLine({ ...base, branch: null, detached: null }), null);
});

test("renders cwd and a clean branch line", () => {
  const { container } = render(<WorkspaceIdentity cwd="~/dev/belay" git={base} />);
  const text = container.textContent ?? "";
  assert.ok(text.includes("~/dev/belay"), text);
  assert.ok(text.includes("main"), text);
  assert.ok(!text.includes("↑") && !text.includes("↓"), "no arrows when ahead/behind are 0");
});

test("renders dirty asterisk and ahead/behind arrows", () => {
  const { container } = render(
    <WorkspaceIdentity
      cwd="~/dev/belay"
      git={{ ...base, branch: "feat/x", dirty: true, ahead: 2, behind: 3 }}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("feat/x*"), text);
  assert.ok(text.includes("↑2"), text);
  assert.ok(text.includes("↓3"), text);
});

test("non-git cwd renders the path alone with no second line", () => {
  const { container } = render(<WorkspaceIdentity cwd="~/Downloads" git={null} />);
  const text = container.textContent ?? "";
  assert.equal(text, "~/Downloads");
});

test("shows a '+N worktrees' link that opens the switcher when other worktrees exist", () => {
  let opened = 0;
  const { getByRole } = render(
    <WorkspaceIdentity
      cwd="~/dev/saccade"
      git={{ ...base, branch: "feat/x" }}
      worktreeCount={3}
      onOpenWorktrees={() => {
        opened += 1;
      }}
    />,
  );
  const link = getByRole("button", { name: /\+3 worktrees/ });
  fireEvent.click(link);
  assert.equal(opened, 1);
});

test("the worktree link is singular for a count of one", () => {
  const { container } = render(
    <WorkspaceIdentity
      cwd="~/dev/saccade"
      git={base}
      worktreeCount={1}
      onOpenWorktrees={() => {}}
    />,
  );
  const text = container.textContent ?? "";
  assert.ok(text.includes("+1 worktree") && !text.includes("+1 worktrees"), text);
});

test("no worktree link when the count is zero or no handler is provided", () => {
  const zero = render(
    <WorkspaceIdentity
      cwd="~/dev/saccade"
      git={base}
      worktreeCount={0}
      onOpenWorktrees={() => {}}
    />,
  );
  assert.equal(zero.queryByText(/worktree/), null);

  const noHandler = render(<WorkspaceIdentity cwd="~/dev/saccade" git={base} worktreeCount={3} />);
  assert.equal(noHandler.queryByText(/worktree/), null);
});

test("long path and branch truncate (the truncate class is applied)", () => {
  const { container } = render(
    <WorkspaceIdentity
      cwd="~/very/deeply/nested/path/that/keeps/going/and/going"
      git={{ ...base, branch: "feature/extremely-long-branch-name-here", ahead: 9 }}
    />,
  );
  const truncated = container.querySelectorAll(".truncate");
  // cwd code + ref span both truncate; the ↑ counter stays shrink-0 and visible.
  assert.ok(truncated.length >= 2, "cwd and ref both carry truncate");
  assert.ok((container.textContent ?? "").includes("↑9"), "the ahead counter survives truncation");
});
