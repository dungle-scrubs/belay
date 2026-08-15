import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { walkContextTree } from "./walk";

function tree(): string {
  return mkdtempSync(join(tmpdir(), "context-walk-"));
}

function write(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x", "utf8");
}

test("multi-segment ignore entries prune by prefix: .belay/generated is never visited", () => {
  const root = tree();
  write(join(root, ".belay", "generated", "CLAUDE.md"));
  write(join(root, ".belay", "generated", "deep", "file.md"));
  write(join(root, ".belay", "rules", "keep.md"));
  write(join(root, "src", "keep.ts"));

  const files = walkContextTree(root);

  assert.ok(
    files.every((path) => !path.includes(`${join(".belay", "generated")}`)),
    `.belay/generated content leaked into the walk: ${files.join(", ")}`,
  );
  assert.ok(
    files.some((path) => path.endsWith(join(".belay", "rules", "keep.md"))),
    "sibling .belay/rules content is still walked",
  );
});

test("single-segment ignore names prune by basename at any depth", () => {
  const root = tree();
  write(join(root, "node_modules", "dep", "CLAUDE.md"));
  write(join(root, "packages", "a", "node_modules", "dep", "CLAUDE.md"));
  write(join(root, "packages", "a", "src", "keep.ts"));

  const files = walkContextTree(root);

  assert.ok(files.every((path) => !path.includes("node_modules")));
  assert.equal(files.length, 1);
});

test("the depth cap prunes a too-deep synthetic tree without descending forever", () => {
  const root = tree();
  // A file at depth 2 (kept) and one at depth 6 (beyond the cap of 3).
  write(join(root, "a", "b", "shallow.txt"));
  write(join(root, "d1", "d2", "d3", "d4", "d5", "d6", "deep.txt"));

  const files = walkContextTree(root, undefined, { maxDepth: 3 });

  assert.ok(
    files.some((path) => path.endsWith("shallow.txt")),
    "the shallow file is kept",
  );
  assert.ok(
    files.every((path) => !path.endsWith("deep.txt")),
    "the beyond-cap file is pruned",
  );
});

test("the entry cap terminates the walk after examining its budget of entries", () => {
  const root = tree();
  for (let i = 0; i < 10; i += 1) {
    write(join(root, `file-${i}.txt`));
  }

  const files = walkContextTree(root, undefined, { maxEntries: 4 });

  assert.ok(files.length <= 4, `expected at most 4 results, got ${files.length}`);
  assert.ok(files.length > 0, "the walk still returns what it examined before the cap");
});
