import assert from "node:assert/strict";
import { test } from "vitest";
import { type GitRunner, readGitStatus } from "./git-status";

/**
 * A fixture runner: maps a joined argv key to its `{ status, stdout }`. Any command not
 * present defaults to a non-zero exit with empty stdout, so a fixture states only the
 * commands it cares about (e.g. an upstream-less repo simply omits the rev-list entry).
 */
function fakeGit(fixtures: Record<string, { status: number; stdout: string }>): GitRunner {
  return (args) => fixtures[args.join(" ")] ?? { status: 1, stdout: "" };
}

const INSIDE = { "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n" } };
const SAME_WORKTREE = {
  "rev-parse --git-dir": { status: 0, stdout: ".git\n" },
  "rev-parse --git-common-dir": { status: 0, stdout: ".git\n" },
};

test("non-git cwd reads null", () => {
  const run = fakeGit({
    "rev-parse --is-inside-work-tree": { status: 128, stdout: "" },
  });
  assert.equal(readGitStatus(run), null);
});

test("clean branch with upstream, no ahead/behind", () => {
  const run = fakeGit({
    ...INSIDE,
    ...SAME_WORKTREE,
    "branch --show-current": { status: 0, stdout: "main\n" },
    "status --porcelain": { status: 0, stdout: "" },
    "rev-list --left-right --count @{upstream}...HEAD": { status: 0, stdout: "0\t0\n" },
  });
  assert.deepEqual(readGitStatus(run), {
    branch: "main",
    detached: null,
    dirty: false,
    ahead: 0,
    behind: 0,
    upstream: true,
    worktree: false,
  });
});

test("dirty branch is dirty on any porcelain output, untracked included", () => {
  const run = fakeGit({
    ...INSIDE,
    ...SAME_WORKTREE,
    "branch --show-current": { status: 0, stdout: "feature\n" },
    "status --porcelain": { status: 0, stdout: "?? new-file.ts\n" },
    "rev-list --left-right --count @{upstream}...HEAD": { status: 0, stdout: "0\t0\n" },
  });
  const out = readGitStatus(run);
  assert.equal(out?.dirty, true);
  assert.equal(out?.branch, "feature");
});

test("ahead-only counts the HEAD-only commits", () => {
  const run = fakeGit({
    ...INSIDE,
    ...SAME_WORKTREE,
    "branch --show-current": { status: 0, stdout: "main\n" },
    "status --porcelain": { status: 0, stdout: "" },
    "rev-list --left-right --count @{upstream}...HEAD": { status: 0, stdout: "0\t3\n" },
  });
  const out = readGitStatus(run);
  assert.equal(out?.ahead, 3);
  assert.equal(out?.behind, 0);
  assert.equal(out?.upstream, true);
});

test("behind-only counts the upstream-only commits", () => {
  const run = fakeGit({
    ...INSIDE,
    ...SAME_WORKTREE,
    "branch --show-current": { status: 0, stdout: "main\n" },
    "status --porcelain": { status: 0, stdout: "" },
    "rev-list --left-right --count @{upstream}...HEAD": { status: 0, stdout: "5\t0\n" },
  });
  const out = readGitStatus(run);
  assert.equal(out?.ahead, 0);
  assert.equal(out?.behind, 5);
});

test("diverged counts both sides", () => {
  const run = fakeGit({
    ...INSIDE,
    ...SAME_WORKTREE,
    "branch --show-current": { status: 0, stdout: "main\n" },
    "status --porcelain": { status: 0, stdout: " M src/a.ts\n" },
    "rev-list --left-right --count @{upstream}...HEAD": { status: 0, stdout: "2\t4\n" },
  });
  const out = readGitStatus(run);
  assert.equal(out?.behind, 2);
  assert.equal(out?.ahead, 4);
  assert.equal(out?.dirty, true);
});

test("detached HEAD reports the short commit and no branch", () => {
  const run = fakeGit({
    ...INSIDE,
    ...SAME_WORKTREE,
    "branch --show-current": { status: 0, stdout: "\n" },
    "rev-parse --short HEAD": { status: 0, stdout: "a1b2c3d\n" },
    "status --porcelain": { status: 0, stdout: "" },
  });
  const out = readGitStatus(run);
  assert.equal(out?.branch, null);
  assert.equal(out?.detached, "a1b2c3d");
  assert.equal(out?.upstream, false);
});

test("no upstream leaves ahead/behind at zero and upstream false", () => {
  const run = fakeGit({
    ...INSIDE,
    ...SAME_WORKTREE,
    "branch --show-current": { status: 0, stdout: "wip\n" },
    "status --porcelain": { status: 0, stdout: "" },
    // rev-list omitted: no upstream -> non-zero exit via the fixture default.
  });
  const out = readGitStatus(run);
  assert.equal(out?.upstream, false);
  assert.equal(out?.ahead, 0);
  assert.equal(out?.behind, 0);
});

test("linked worktree detected when git-dir differs from common-dir", () => {
  const run = fakeGit({
    ...INSIDE,
    "branch --show-current": { status: 0, stdout: "feat/x\n" },
    "status --porcelain": { status: 0, stdout: "" },
    "rev-list --left-right --count @{upstream}...HEAD": { status: 1, stdout: "" },
    "rev-parse --git-dir": {
      status: 0,
      stdout: "/repo/.git/worktrees/feat\n",
    },
    "rev-parse --git-common-dir": { status: 0, stdout: "/repo/.git\n" },
  });
  const out = readGitStatus(run);
  assert.equal(out?.worktree, true);
});
