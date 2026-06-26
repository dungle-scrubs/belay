import assert from "node:assert/strict";
import { render } from "@testing-library/react";
import type { GitStatus } from "@trevor/session";
import { test } from "vitest";
import { gitLine, WorkspaceIdentity } from "./WorkspaceIdentity";

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
  const { container } = render(<WorkspaceIdentity cwd="~/dev/trevorV2" git={base} />);
  const text = container.textContent ?? "";
  assert.ok(text.includes("~/dev/trevorV2"), text);
  assert.ok(text.includes("main"), text);
  assert.ok(!text.includes("↑") && !text.includes("↓"), "no arrows when ahead/behind are 0");
});

test("renders dirty asterisk and ahead/behind arrows", () => {
  const { container } = render(
    <WorkspaceIdentity
      cwd="~/dev/trevorV2"
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
