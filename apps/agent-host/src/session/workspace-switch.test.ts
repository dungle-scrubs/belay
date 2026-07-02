import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkspaceSwitchFs } from "./workspace-switch";
import { resolveCdTarget, resolveWorkspaceRoot } from "./workspace-switch";

function fakeFs(
  dirs: readonly string[],
  realpaths: Record<string, string> = {},
): WorkspaceSwitchFs {
  const present = new Set(dirs);
  return {
    exists: (path) => present.has(path),
    isDirectory: (path) => present.has(path),
    realpath: (path) => realpaths[path] ?? path,
  };
}

test("resolveWorkspaceRoot walks up to the nearest git root", () => {
  const fs = fakeFs(["/repo/.git", "/repo/apps/web"]);
  assert.equal(resolveWorkspaceRoot("/repo/apps/web", fs), "/repo");
});

test("resolveWorkspaceRoot falls back to cwd outside a git worktree", () => {
  const fs = fakeFs(["/tmp/project"]);
  assert.equal(resolveWorkspaceRoot("/tmp/project", fs), "/tmp/project");
});

test("/cd target resolves relative paths, realpaths, git workspace, and fresh session id", () => {
  const fs = fakeFs(["/repo/apps/web", "/private/repo/.git"], {
    "/repo/apps/web": "/private/repo/apps/web",
  });
  const out = resolveCdTarget("apps/web", {
    cwd: "/repo",
    fs,
    now: new Date("2026-06-26T12:34:56.000Z"),
    random: "entropy",
  });

  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value.cwd, "/private/repo/apps/web");
  assert.equal(out.value.workspace, "/private/repo");
  assert.match(out.value.sessionId, /^web-20260626-123456z-[0-9a-f]{8}$/);
});

test("/cd target expands home and rejects non-directories", () => {
  const fs = fakeFs(["/Users/kevin/dev"]);
  const ok = resolveCdTarget("~/dev", {
    cwd: "/repo",
    fs,
    home: "/Users/kevin",
    now: new Date("2026-06-26T12:34:56.000Z"),
    random: "entropy",
  });
  assert.equal(ok.ok, true);

  const missing = resolveCdTarget("~/missing", { cwd: "/repo", fs, home: "/Users/kevin" });
  assert.deepEqual(missing, { ok: false, error: "No such directory: /Users/kevin/missing" });
});

test("/cd target accepts matching quotes around paths with spaces", () => {
  const fs = fakeFs(["/Users/kevin/My Project"]);
  const out = resolveCdTarget('"/Users/kevin/My Project"', {
    cwd: "/repo",
    fs,
    now: new Date("2026-06-26T12:34:56.000Z"),
    random: "entropy",
  });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value.cwd, "/Users/kevin/My Project");
});

test("/cd target requires an argument", () => {
  assert.deepEqual(resolveCdTarget("   ", { cwd: "/repo", fs: fakeFs([]) }), {
    ok: false,
    error: "usage: /cd <directory>",
  });
});
