import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { buildFileIndex } from "./file-search";

const root = "/ws";
const abs = (...segments: string[]): string => join(root, ...segments);

function tempTree(): string {
  return mkdtempSync(join(tmpdir(), "file-search-"));
}

function write(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x", "utf8");
}

test("relativizes the walked absolute paths to sorted, workspace-relative POSIX paths", () => {
  const index = buildFileIndex({
    root,
    walk: () => [abs("src", "b.ts"), abs("a.ts"), abs("src", "a.ts")],
  });
  assert.deepEqual(
    index.files.map((f) => f.path),
    ["a.ts", "src/a.ts", "src/b.ts"],
  );
  assert.equal(index.truncated, false);
});

test("confines to the workspace: paths escaping the root (and the root itself) are dropped", () => {
  const index = buildFileIndex({
    root,
    walk: () => [abs("keep.ts"), join(root, ".."), "/etc/passwd", join(root, "..", "secret.ts")],
  });
  assert.deepEqual(
    index.files.map((f) => f.path),
    ["keep.ts"],
  );
});

test("de-dupes repeated paths from the walk", () => {
  const index = buildFileIndex({ root, walk: () => [abs("a.ts"), abs("a.ts")] });
  assert.equal(index.files.length, 1);
});

test("caps the index and reports truncation when the workspace is larger", () => {
  const index = buildFileIndex({
    root,
    cap: 2,
    walk: () => [abs("a.ts"), abs("b.ts"), abs("c.ts")],
  });
  assert.deepEqual(
    index.files.map((f) => f.path),
    ["a.ts", "b.ts"],
  );
  assert.equal(index.truncated, true);
});

test("an empty workspace yields an empty, non-truncated index", () => {
  const index = buildFileIndex({ root, walk: () => [] });
  assert.deepEqual(index.files, []);
  assert.equal(index.truncated, false);
});

test("the default walk applies the shared ignore policy and keeps hidden files", () => {
  const dir = tempTree();
  write(join(dir, "src", "keep.ts"));
  write(join(dir, "node_modules", "dep", "index.js"));
  write(join(dir, ".git", "config"));
  write(join(dir, ".gitignore"));
  write(join(dir, ".github", "workflows", "ci.yml"));

  const files = buildFileIndex({ root: dir }).files.map((f) => f.path);

  assert.ok(!files.some((p) => p.includes("node_modules")), "node_modules pruned");
  assert.ok(!files.some((p) => p.includes(".git/")), ".git pruned");
  assert.ok(files.includes("src/keep.ts"), "normal file kept");
  assert.ok(files.includes(".gitignore"), "hidden file kept");
  assert.ok(files.includes(".github/workflows/ci.yml"), "non-ignored hidden dir kept");
});
