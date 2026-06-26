import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, test } from "vitest";
import { contextRegistry } from "./registry";

/**
 * Session-scoped lazy below-cwd AGENTS.md (D-080, M3): a directory-scoped context file loads only
 * AFTER a file in that subtree is touched, is deduped (each directory once), survives a compaction
 * fold (the registry is independent of history), and resets on /clear.
 */

function tree(): string {
  return mkdtempSync(join(tmpdir(), "ctx-registry-"));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

beforeEach(() => {
  contextRegistry.reset();
});

test("a below-cwd AGENTS.md is absent until a file in that subtree is touched", () => {
  const root = tree();
  write(join(root, "sub", "AGENTS.md"), "SUB RULE: use snake_case here.");
  write(join(root, "sub", "x.ts"), "code");

  // Before any access, the eager scope at cwd=root has no AGENTS.md, so nothing is rendered.
  assert.equal(contextRegistry.report(root, root).text, "");

  // Touch a file inside sub/ -> the subtree's AGENTS.md loads.
  contextRegistry.noteFileAccess(join(root, "sub", "x.ts"), root);
  const report = contextRegistry.report(root, root);
  assert.match(report.text, /SUB RULE: use snake_case here\./);
  assert.deepEqual(report.scopes, ["below-cwd"]);
  assert.deepEqual(report.files, [join(root, "sub", "AGENTS.md")]);
});

test("the lazy set is deduped: a second touch in the same subtree does not double it", () => {
  const root = tree();
  write(join(root, "sub", "AGENTS.md"), "ONLY ONCE");
  contextRegistry.noteFileAccess(join(root, "sub", "a.ts"), root);
  contextRegistry.noteFileAccess(join(root, "sub", "b.ts"), root);
  const report = contextRegistry.report(root, root);
  assert.equal(report.files.length, 1, "the directory's AGENTS.md is tracked exactly once");
  assert.equal(report.text.match(/ONLY ONCE/g)?.length, 1);
});

test("deeper nesting loads every AGENTS.md between cwd and the file, parent before child", () => {
  const root = tree();
  write(join(root, "a", "AGENTS.md"), "A RULES");
  write(join(root, "a", "b", "AGENTS.md"), "B RULES");
  write(join(root, "a", "b", "deep.ts"), "code");
  contextRegistry.noteFileAccess(join(root, "a", "b", "deep.ts"), root);
  const report = contextRegistry.report(root, root);
  assert.deepEqual(report.files, [join(root, "a", "AGENTS.md"), join(root, "a", "b", "AGENTS.md")]);
  assert.ok(report.text.indexOf("A RULES") < report.text.indexOf("B RULES"), "parent before child");
});

test("a file directly in cwd adds no below-cwd context (the eager scope already covers cwd)", () => {
  const root = tree();
  write(join(root, "y.ts"), "code");
  contextRegistry.noteFileAccess(join(root, "y.ts"), root);
  assert.equal(contextRegistry.report(root, root).text, "");
});

test("the lazy set survives a fold: it re-renders on a later turn unchanged", () => {
  const root = tree();
  write(join(root, "sub", "AGENTS.md"), "STILL HERE");
  contextRegistry.noteFileAccess(join(root, "sub", "x.ts"), root);
  // A compaction fold rewrites HISTORY, not the registry - so a later turn's render still has it.
  const first = contextRegistry.report(root, root).text;
  const afterFold = contextRegistry.report(root, root).text;
  assert.match(first, /STILL HERE/);
  assert.equal(afterFold, first, "the lazy context is re-injected identically on the next turn");
});

test("reset() drops the lazy set (a /clear starts the below-cwd scope fresh)", () => {
  const root = tree();
  write(join(root, "sub", "AGENTS.md"), "TRANSIENT");
  contextRegistry.noteFileAccess(join(root, "sub", "x.ts"), root);
  assert.match(contextRegistry.report(root, root).text, /TRANSIENT/);
  contextRegistry.reset();
  assert.equal(contextRegistry.report(root, root).text, "");
});

test("below-cwd context sits AFTER the eager project scope (most specific wins)", () => {
  const root = tree();
  write(join(root, "AGENTS.md"), "ROOT SCOPE");
  write(join(root, "sub", "AGENTS.md"), "BELOW SCOPE");
  contextRegistry.noteFileAccess(join(root, "sub", "x.ts"), root);
  const report = contextRegistry.report(root, root);
  assert.deepEqual(report.scopes, ["project", "below-cwd"]);
  assert.ok(
    report.text.indexOf("ROOT SCOPE") < report.text.indexOf("BELOW SCOPE"),
    "the eager project scope precedes the lazy below-cwd scope",
  );
});
