import assert from "node:assert/strict";
import { test } from "vitest";
import {
  branchSlug,
  listWorktrees,
  loadWorktrees,
  removeWorktreeRecord,
  repoWorktreesDir,
  saveWorktree,
  type WorktreeFs,
  type WorktreeRecord,
  worktreePathFor,
  worktreesForRepo,
} from "./registry";

function fakeFs(seed: Record<string, string> = {}): WorktreeFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    exists: (p) => files.has(p),
  };
}

const HOME = "/home/.trevorV2";

const record = (over: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
  id: "abc12345",
  baseRepo: "/dev/trevorV2",
  baseRepoName: "trevorV2",
  worktreePath: "/home/.trevorV2/.worktrees/hash/feat-x-abc12345",
  branch: "feat/x",
  baseCommit: "deadbeef",
  sessionId: "trevorV2-aaaa1111",
  createdAt: "2026-06-26T00:00:00.000Z",
  updatedAt: "2026-06-26T00:00:00.000Z",
  status: "active",
  ...over,
});

test("branchSlug makes a filesystem-safe slug", () => {
  assert.equal(branchSlug("feat/sidebar-git"), "feat-sidebar-git");
  assert.equal(branchSlug("///"), "wt");
});

test("repoWorktreesDir groups by a hash of the canonical repo, not the full path", () => {
  const dir = repoWorktreesDir(HOME, "/dev/trevorV2");
  assert.ok(dir.startsWith(`${HOME}/.worktrees/`));
  // The full repo path never appears in the grouping directory name.
  assert.ok(!dir.includes("/dev/trevorV2"));
  // Stable + distinct: same repo same dir, different repo different dir.
  assert.equal(repoWorktreesDir(HOME, "/dev/trevorV2"), dir);
  assert.notEqual(repoWorktreesDir(HOME, "/dev/other"), dir);
});

test("worktreePathFor lays out <repo-hash>/<branch-slug>-<id>", () => {
  const p = worktreePathFor(HOME, "/dev/trevorV2", "feat/x", "abc12345");
  assert.ok(p.endsWith("/feat-x-abc12345"));
  assert.ok(p.includes("/.worktrees/"));
});

test("save / load / remove round-trips a record, dropping malformed entries", () => {
  const fs = fakeFs();
  saveWorktree(fs, HOME, record());
  assert.deepEqual(loadWorktrees(fs, HOME), { abc12345: record() });

  // A malformed registry entry is dropped on read, never returned.
  const path = `${HOME}/.worktrees/registry.json`;
  fs.files.set(path, JSON.stringify({ good: record({ id: "good" }), bad: { nope: true } }));
  assert.deepEqual(Object.keys(loadWorktrees(fs, HOME)), ["good"]);

  removeWorktreeRecord(fs, HOME, "good");
  assert.deepEqual(loadWorktrees(fs, HOME), {});
});

test("listWorktrees flags a record whose directory is gone as missing (stale)", () => {
  const present = record({ id: "here", worktreePath: "/wt/here" });
  const gone = record({ id: "gone", worktreePath: "/wt/gone" });
  const fs = fakeFs();
  saveWorktree(fs, HOME, present);
  saveWorktree(fs, HOME, gone);
  fs.files.set("/wt/here", ""); // only "here" exists on disk

  const views = listWorktrees(fs, HOME).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(views.find((v) => v.id === "here")?.missing, false);
  assert.equal(views.find((v) => v.id === "gone")?.missing, true);
});

test("worktreesForRepo filters by canonical identity and excludes archived", () => {
  const fs = fakeFs();
  saveWorktree(fs, HOME, record({ id: "a", baseRepo: "/dev/trevorV2", worktreePath: "/wt/a" }));
  saveWorktree(fs, HOME, record({ id: "b", baseRepo: "/dev/other", worktreePath: "/wt/b" }));
  saveWorktree(
    fs,
    HOME,
    record({ id: "c", baseRepo: "/dev/trevorV2", worktreePath: "/wt/c", status: "archived" }),
  );
  fs.files.set("/wt/a", "");

  const forRepo = worktreesForRepo(fs, HOME, "/dev/trevorV2");
  assert.deepEqual(
    forRepo.map((v) => v.id),
    ["a"],
  );
});

test("a missing registry tolerates reads as an empty list", () => {
  const fs = fakeFs();
  assert.deepEqual(loadWorktrees(fs, HOME), {});
  assert.deepEqual(listWorktrees(fs, HOME), []);
});
