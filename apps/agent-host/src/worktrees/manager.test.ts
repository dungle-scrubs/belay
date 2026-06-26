import assert from "node:assert/strict";
import { test } from "vitest";
import type { GitRunner } from "../git-status";
import { WorktreeManager, type WorktreeManagerDeps } from "./manager";
import { loadWorktrees, type WorktreeFs } from "./registry";

function fakeFs(): WorktreeFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    exists: (p) => files.has(p),
    remove: (p) => void files.delete(p),
  };
}

const HOME = "/home/.trevorV2";

/** A clean-branch git runner for any cwd; per-cwd overrides simulate dirty/conflict/etc. */
function gitFactory(
  overrides: Record<string, Partial<Record<string, { status: number; stdout: string }>>> = {},
): (cwd: string) => GitRunner {
  return (cwd) => (args) => {
    const key = args.join(" ");
    const perCwd = overrides[cwd]?.[key];
    if (perCwd) {
      return perCwd;
    }
    // Defaults: a clean repo on `main` with an upstream, no conflict, main worktree.
    const table: Record<string, { status: number; stdout: string }> = {
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "true\n" },
      "branch --show-current": { status: 0, stdout: "main\n" },
      "status --porcelain": { status: 0, stdout: "" },
      "rev-list --left-right --count @{upstream}...HEAD": { status: 0, stdout: "0\t0\n" },
      "rev-parse --git-dir": { status: 0, stdout: ".git\n" },
      "rev-parse --git-common-dir": { status: 0, stdout: ".git\n" },
      "diff --name-only --diff-filter=U": { status: 0, stdout: "" },
      "rev-parse HEAD": { status: 0, stdout: "cafef00d\n" },
      "worktree add -b feat/x /home/.trevorV2/.worktrees/": { status: 0, stdout: "" },
    };
    if (key.startsWith("worktree add")) {
      return { status: 0, stdout: "" };
    }
    if (key.startsWith("worktree remove")) {
      return { status: 0, stdout: "" };
    }
    if (key === "worktree prune") {
      return { status: 0, stdout: "" };
    }
    return table[key] ?? { status: 1, stdout: "" };
  };
}

function manager(
  fs: WorktreeFs,
  gitRunnerFor: (cwd: string) => GitRunner,
  over: Partial<WorktreeManagerDeps> = {},
): WorktreeManager {
  let counter = 0;
  const genId = () => {
    counter += 1;
    return `id${counter}`;
  };
  return new WorktreeManager({
    fs,
    home: HOME,
    gitRunnerFor,
    abbrev: (p) => p.replace("/dev", "~"),
    now: () => "2026-06-26T00:00:00.000Z",
    genId,
    ...over,
  });
}

const ctx = {
  baseRepo: "/dev/trevorV2",
  baseRepoName: "trevorV2",
  basePath: "/dev/trevorV2",
  baselineSessionId: "trevorV2-base",
  currentPath: "/dev/trevorV2",
};

test("create records a worktree at the grouped path and binds it to a session", () => {
  const fs = fakeFs();
  const mgr = manager(fs, gitFactory());
  const result = mgr.create({
    baseRepo: ctx.baseRepo,
    baseRepoName: ctx.baseRepoName,
    basePath: ctx.basePath,
    branch: "feat/x",
    baseRef: "main",
    sessionId: "wt-session",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.record.branch, "feat/x");
  assert.equal(result.record.sessionId, "wt-session");
  assert.equal(result.record.baseCommit, "cafef00d");
  assert.ok(result.record.worktreePath.includes("/.worktrees/"));
  // Persisted to the registry.
  assert.equal(Object.keys(loadWorktrees(fs, HOME)).length, 1);
});

test("create surfaces a git failure as a typed error and records nothing", () => {
  const fs = fakeFs();
  const failing = gitFactory({
    "/dev/trevorV2": { "worktree add -b feat/x ": { status: 128, stdout: "" } },
  });
  // Force any `worktree add` to fail by overriding the prefix path.
  const mgr = manager(fs, (cwd) => (args) => {
    if (args[0] === "worktree" && args[1] === "add") {
      return { status: 128, stdout: "" };
    }
    return failing(cwd)(args);
  });
  const result = mgr.create({
    baseRepo: ctx.baseRepo,
    baseRepoName: ctx.baseRepoName,
    basePath: ctx.basePath,
    branch: "feat/x",
    baseRef: "main",
    sessionId: "wt-session",
  });
  assert.equal(result.ok, false);
  assert.equal(Object.keys(loadWorktrees(fs, HOME)).length, 0);
});

test("summaries lists a baseline row first, then managed worktrees with git state", () => {
  const fs = fakeFs();
  const mgr = manager(fs, gitFactory());
  const created = mgr.create({
    baseRepo: ctx.baseRepo,
    baseRepoName: ctx.baseRepoName,
    basePath: ctx.basePath,
    branch: "feat/x",
    baseRef: "main",
    sessionId: "wt-session",
  });
  assert.ok(created.ok);
  if (!created.ok) return;
  fs.files.set(created.record.worktreePath, ""); // the worktree dir exists on disk

  const rows = mgr.summaries(ctx);
  assert.equal(rows[0]?.baseline, true);
  assert.equal(rows[0]?.current, true); // currentPath === basePath
  assert.equal(rows[0]?.path, "~/trevorV2");
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.baseline, false);
  assert.equal(rows[1]?.branch, "main"); // git-read from the worktree (clean default)
});

test("a worktree whose directory is gone shows as missing and is not git-read", () => {
  const fs = fakeFs();
  const mgr = manager(fs, gitFactory());
  const created = mgr.create({
    baseRepo: ctx.baseRepo,
    baseRepoName: ctx.baseRepoName,
    basePath: ctx.basePath,
    branch: "feat/x",
    baseRef: "main",
    sessionId: "wt-session",
  });
  assert.ok(created.ok);
  // Do NOT create the directory on disk → missing.
  const row = mgr.summaries(ctx).find((r) => !r.baseline);
  assert.equal(row?.missing, true);
});

test("resolveSwitch returns the baseline target, a worktree target, and blocks a missing path", () => {
  const fs = fakeFs();
  const mgr = manager(fs, gitFactory());
  assert.deepEqual(mgr.resolveSwitch("baseline", ctx), {
    ok: true,
    path: "/dev/trevorV2",
    sessionId: "trevorV2-base",
  });

  const created = mgr.create({
    baseRepo: ctx.baseRepo,
    baseRepoName: ctx.baseRepoName,
    basePath: ctx.basePath,
    branch: "feat/x",
    baseRef: "main",
    sessionId: "wt-session",
  });
  assert.ok(created.ok);
  if (!created.ok) return;

  // Missing path → blocked/repair (never a silent baseline fallback).
  const blocked = mgr.resolveSwitch(created.record.id, ctx);
  assert.equal(blocked.ok, false);

  // Present path → its own cwd + session.
  fs.files.set(created.record.worktreePath, "");
  const ok = mgr.resolveSwitch(created.record.id, ctx);
  assert.deepEqual(ok, {
    ok: true,
    path: created.record.worktreePath,
    sessionId: "wt-session",
  });

  assert.equal(mgr.resolveSwitch("nope", ctx).ok, false);
});

test("reconcile drops records whose directory disappeared and prunes git", () => {
  const fs = fakeFs();
  let pruned = false;
  const mgr = manager(fs, (cwd) => (args) => {
    if (args.join(" ") === "worktree prune") {
      pruned = true;
      return { status: 0, stdout: "" };
    }
    return gitFactory()(cwd)(args);
  });
  const created = mgr.create({
    baseRepo: ctx.baseRepo,
    baseRepoName: ctx.baseRepoName,
    basePath: ctx.basePath,
    branch: "feat/x",
    baseRef: "main",
    sessionId: "wt-session",
  });
  assert.ok(created.ok);
  // Path never created on disk → reconcile removes it.
  const gone = mgr.reconcile(ctx.basePath);
  assert.equal(gone.length, 1);
  assert.equal(pruned, true);
  assert.equal(Object.keys(loadWorktrees(fs, HOME)).length, 0);
});

test("remove deletes the directory + record; merge-back merges the branch", () => {
  const fs = fakeFs();
  const merges: string[] = [];
  const mgr = manager(fs, (cwd) => (args) => {
    if (args[0] === "merge") {
      merges.push(args[args.length - 1] as string);
      return { status: 0, stdout: "" };
    }
    return gitFactory()(cwd)(args);
  });
  const created = mgr.create({
    baseRepo: ctx.baseRepo,
    baseRepoName: ctx.baseRepoName,
    basePath: ctx.basePath,
    branch: "feat/x",
    baseRef: "main",
    sessionId: "wt-session",
  });
  assert.ok(created.ok);
  if (!created.ok) return;

  const merged = mgr.mergeBack(created.record.id, ctx.basePath);
  assert.equal(merged.ok, true);
  assert.deepEqual(merges, ["feat/x"]);

  const removed = mgr.remove(created.record.id, ctx.basePath, true);
  assert.equal(removed.ok, true);
  assert.equal(Object.keys(loadWorktrees(fs, HOME)).length, 0);
});

test("remove without force refuses a dirty worktree (the confirmation gate)", () => {
  const fs = fakeFs();
  // A worktree whose own directory reads dirty.
  const mgr = manager(fs, (cwd) => (args) => {
    const base = gitFactory()(cwd);
    if (cwd.includes("/.worktrees/") && args.join(" ") === "status --porcelain") {
      return { status: 0, stdout: " M file.ts\n" };
    }
    return base(args);
  });
  const created = mgr.create({
    baseRepo: ctx.baseRepo,
    baseRepoName: ctx.baseRepoName,
    basePath: ctx.basePath,
    branch: "feat/x",
    baseRef: "main",
    sessionId: "wt-session",
  });
  assert.ok(created.ok);
  if (!created.ok) return;
  fs.files.set(created.record.worktreePath, ""); // exists on disk + dirty

  const refused = mgr.remove(created.record.id, ctx.basePath, false);
  assert.equal(refused.ok, false);
  // The record survives a refused delete.
  assert.equal(Object.keys(loadWorktrees(fs, HOME)).length, 1);

  // Forcing past the gate removes it.
  assert.equal(mgr.remove(created.record.id, ctx.basePath, true).ok, true);
  assert.equal(Object.keys(loadWorktrees(fs, HOME)).length, 0);
});
