import assert from "node:assert/strict";
import { test } from "vitest";
import { addWorktree, hasConflict, mainWorktreeRoot, mergeBranch, removeWorktree } from "./git";
import type { GitRunner } from "./git-status";

function fakeGit(fixtures: Record<string, { status: number; stdout: string }>): GitRunner {
  return (args) => fixtures[args.join(" ")] ?? { status: 1, stdout: "" };
}

test("mainWorktreeRoot resolves a linked worktree to the shared repo root", () => {
  // --git-common-dir is the SHARED .git for both the main checkout and any linked worktree.
  const run = fakeGit({
    "rev-parse --path-format=absolute --git-common-dir": { status: 0, stdout: "/repo/.git\n" },
  });
  assert.equal(mainWorktreeRoot(run), "/repo");
});

test("mainWorktreeRoot falls back to the toplevel for an unusual layout", () => {
  const run = fakeGit({
    "rev-parse --path-format=absolute --git-common-dir": { status: 0, stdout: "/bare.git\n" },
    "rev-parse --show-toplevel": { status: 0, stdout: "/work\n" },
  });
  assert.equal(mainWorktreeRoot(run), "/work");
});

test("addWorktree maps a non-zero exit to a typed error", () => {
  const ok = fakeGit({ "worktree add -b feat/x /wt main": { status: 0, stdout: "" } });
  assert.deepEqual(addWorktree(ok, "/wt", "feat/x", "main"), { ok: true });

  const fail = fakeGit({});
  const result = addWorktree(fail, "/wt", "feat/x", "main");
  assert.equal(result.ok, false);
});

test("removeWorktree passes --force only when forcing", () => {
  const calls: string[][] = [];
  const run: GitRunner = (args) => {
    calls.push([...args]);
    return { status: 0, stdout: "" };
  };
  removeWorktree(run, "/wt", false);
  removeWorktree(run, "/wt", true);
  assert.deepEqual(calls[0], ["worktree", "remove", "/wt"]);
  assert.deepEqual(calls[1], ["worktree", "remove", "--force", "/wt"]);
});

test("hasConflict is true when there are unmerged paths", () => {
  assert.equal(
    hasConflict(fakeGit({ "diff --name-only --diff-filter=U": { status: 0, stdout: "a.ts\n" } })),
    true,
  );
  assert.equal(
    hasConflict(fakeGit({ "diff --name-only --diff-filter=U": { status: 0, stdout: "" } })),
    false,
  );
});

test("mergeBranch reports a non-zero exit as a conflict/error", () => {
  assert.equal(
    mergeBranch(fakeGit({ "merge --no-edit feat/x": { status: 0, stdout: "" } }), "feat/x").ok,
    true,
  );
  assert.equal(mergeBranch(fakeGit({}), "feat/x").ok, false);
});
