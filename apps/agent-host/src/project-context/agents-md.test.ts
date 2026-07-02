import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { collectEagerContext, projectDirs, readAgentsFile } from "./agents-md";

/**
 * Nested AGENTS.md eager loading (D-080): walk the project root down to cwd, one file per directory,
 * plus the user-global file loaded first; concatenate root->cwd so cwd wins; expand @path imports
 * (capped, cycle-safe, code-spans ignored); budget with deterministic, reported truncation. Driven
 * with real temp trees so the filesystem walk is exercised end to end.
 */

function tree(): string {
  return mkdtempSync(join(tmpdir(), "agents-md-"));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

// A user-global path that does not exist, so tests isolate the project walk unless they set one.
const NO_USER_GLOBAL = join(tmpdir(), "agents-md-no-such-user-global", "AGENTS.md");

test("a root-only repo ingests the single AGENTS.md", () => {
  const root = tree();
  write(join(root, "AGENTS.md"), "Use tabs, not spaces.");
  const report = collectEagerContext({
    cwd: root,
    workspaceRoot: root,
    userGlobal: NO_USER_GLOBAL,
  });
  assert.match(report.text, /Use tabs, not spaces\./);
  assert.deepEqual(report.files, [join(root, "AGENTS.md")]);
  assert.deepEqual(report.scopes, ["project"]);
  assert.equal(report.truncated, false);
});

test("a nested chain merges root->cwd with cwd appearing last (it wins on conflict)", () => {
  const root = tree();
  write(join(root, "AGENTS.md"), "ROOT: run pnpm test.");
  write(join(root, "apps", "AGENTS.md"), "APPS: prefer Effect.");
  write(join(root, "apps", "web", "AGENTS.md"), "WEB: React 19 only.");
  const cwd = join(root, "apps", "web");
  const report = collectEagerContext({ cwd, workspaceRoot: root, userGlobal: NO_USER_GLOBAL });
  // All three are ingested, ordered root -> apps -> web.
  assert.deepEqual(report.files, [
    join(root, "AGENTS.md"),
    join(root, "apps", "AGENTS.md"),
    join(cwd, "AGENTS.md"),
  ]);
  // Positional precedence: the cwd file's content appears AFTER the root's in the rendered block.
  assert.ok(
    report.text.indexOf("ROOT: run pnpm test.") < report.text.indexOf("WEB: React 19 only."),
  );
});

test("the walk stops at a .git repo root and never climbs past it", () => {
  const outer = tree();
  write(join(outer, "AGENTS.md"), "OUTER: should not be read.");
  const repo = join(outer, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  write(join(repo, "AGENTS.md"), "REPO: this is the boundary.");
  const cwd = join(repo, "src");
  write(join(cwd, "AGENTS.md"), "SRC: deepest.");
  // workspaceRoot is the OUTER dir, but the .git at repo/ must stop the climb there.
  const report = collectEagerContext({ cwd, workspaceRoot: outer, userGlobal: NO_USER_GLOBAL });
  assert.ok(!report.text.includes("OUTER: should not be read."), "never climbs past the repo root");
  assert.match(report.text, /REPO: this is the boundary\./);
  assert.match(report.text, /SRC: deepest\./);
  assert.deepEqual(projectDirs(cwd, outer), [repo, cwd]);
});

test("the walk never goes above the workspace root", () => {
  const above = tree();
  write(join(above, "AGENTS.md"), "ABOVE: outside the workspace.");
  const root = join(above, "ws");
  write(join(root, "AGENTS.md"), "ROOT.");
  const report = collectEagerContext({
    cwd: root,
    workspaceRoot: root,
    userGlobal: NO_USER_GLOBAL,
  });
  assert.ok(!report.text.includes("ABOVE: outside the workspace."));
  assert.deepEqual(report.files, [join(root, "AGENTS.md")]);
});

test("the user-global file is loaded first (lowest precedence)", () => {
  const root = tree();
  const userHome = tree();
  write(join(userHome, "AGENTS.md"), "GLOBAL: my personal style.");
  write(join(root, "AGENTS.md"), "PROJECT: repo rules.");
  const report = collectEagerContext({
    cwd: root,
    workspaceRoot: root,
    userGlobal: join(userHome, "AGENTS.md"),
  });
  assert.deepEqual(report.scopes, ["user-global", "project"]);
  assert.ok(
    report.text.indexOf("GLOBAL: my personal style.") < report.text.indexOf("PROJECT: repo rules."),
    "the user-global content comes before the project content",
  );
});

test("@path imports are expanded relative to the importing file", () => {
  const root = tree();
  write(join(root, "AGENTS.md"), "Main rules.\n\nSee @docs/style.md for details.");
  write(join(root, "docs", "style.md"), "STYLE: two-space indent.");
  const report = collectEagerContext({
    cwd: root,
    workspaceRoot: root,
    userGlobal: NO_USER_GLOBAL,
  });
  assert.match(report.text, /STYLE: two-space indent\./, "the imported file is inlined");
  assert.ok(!report.text.includes("@docs/style.md"), "the @path token is replaced");
});

test("@path import nesting is capped at 4 hops", () => {
  const root = tree();
  write(join(root, "AGENTS.md"), "L0 @a.md");
  write(join(root, "a.md"), "L1 @b.md");
  write(join(root, "b.md"), "L2 @c.md");
  write(join(root, "c.md"), "L3 @d.md");
  write(join(root, "d.md"), "L4 @e.md");
  write(join(root, "e.md"), "L5 DEEP");
  const text = readAgentsFile(join(root, "AGENTS.md")) ?? "";
  // 4 hops of expansion reach L4; the 5th import (@e.md) is left literal, not inlined.
  assert.match(text, /L4/);
  assert.ok(!text.includes("L5 DEEP"), "the 5th hop is not expanded");
  assert.match(text, /@e\.md/, "the capped import stays a literal token");
});

test("a circular @path import is broken with a visible note", () => {
  const root = tree();
  write(join(root, "AGENTS.md"), "start @loop.md");
  write(join(root, "loop.md"), "loop body @AGENTS.md");
  const text = readAgentsFile(join(root, "AGENTS.md")) ?? "";
  assert.match(text, /loop body/, "the import is followed once");
  assert.match(text, /skipped circular import/, "the cycle back to the root is broken with a note");
});

test("@paths inside code spans are ignored", () => {
  const root = tree();
  write(join(root, "secret.md"), "SECRET");
  write(
    join(root, "AGENTS.md"),
    [
      "Inline `@secret.md` stays literal.",
      "",
      "```",
      "fenced @secret.md stays literal",
      "```",
    ].join("\n"),
  );
  const text = readAgentsFile(join(root, "AGENTS.md")) ?? "";
  assert.ok(!text.includes("SECRET"), "neither inline nor fenced @path is expanded");
  assert.match(text, /`@secret\.md`/, "the inline code span is preserved verbatim");
});

test("the byte budget truncates the lowest-precedence source first and reports the drop", () => {
  const root = tree();
  const big = "X".repeat(5_000);
  write(join(root, "AGENTS.md"), `ROOTBIG ${big}`);
  write(join(root, "sub", "AGENTS.md"), "CWD KEEP ME");
  const cwd = join(root, "sub");
  // Budget fits the small cwd file plus only a slice of the big root file.
  const report = collectEagerContext({
    cwd,
    workspaceRoot: root,
    userGlobal: NO_USER_GLOBAL,
    budget: 200,
  });
  assert.equal(report.truncated, true);
  assert.ok(report.bytesDropped > 0, "the overflow is reported, not silent");
  assert.match(report.text, /CWD KEEP ME/, "the highest-precedence (cwd) source is kept whole");
  assert.match(report.text, /…\[truncated\]/, "the lowest-precedence source is truncated in place");
});

test("no AGENTS.md anywhere yields an empty report (prompt unchanged)", () => {
  const root = tree();
  const report = collectEagerContext({
    cwd: root,
    workspaceRoot: root,
    userGlobal: NO_USER_GLOBAL,
  });
  assert.equal(report.text, "");
  assert.deepEqual(report.files, []);
  assert.equal(report.truncated, false);
});
