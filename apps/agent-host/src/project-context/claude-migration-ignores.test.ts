import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { addPermanentlyIgnored, loadPermanentlyIgnored } from "./claude-migration-ignores";

function storeFile(): string {
  return join(mkdtempSync(join(tmpdir(), "claude-ignores-")), "claude-migration-ignores.json");
}

test("an empty or missing store yields no ignored files", () => {
  const file = storeFile();
  assert.equal(loadPermanentlyIgnored("/repo", file).size, 0);
  assert.equal(existsSync(file), false, "loading never creates the store");
});

test("added ignores persist per project root and round-trip", () => {
  const file = storeFile();
  addPermanentlyIgnored("/repo/a", ["CLAUDE.md", "pkg/CLAUDE.md"], file);
  addPermanentlyIgnored("/repo/b", ["other/CLAUDE.md"], file);

  const a = loadPermanentlyIgnored("/repo/a", file);
  assert.deepEqual([...a].sort(), ["CLAUDE.md", "pkg/CLAUDE.md"]);
  assert.deepEqual([...loadPermanentlyIgnored("/repo/b", file)], ["other/CLAUDE.md"]);
  // A project with no recorded decisions is unaffected.
  assert.equal(loadPermanentlyIgnored("/repo/c", file).size, 0);
});

test("adding an already-ignored file is idempotent (deduped, no duplicates)", () => {
  const file = storeFile();
  addPermanentlyIgnored("/repo", ["CLAUDE.md"], file);
  addPermanentlyIgnored("/repo", ["CLAUDE.md", "pkg/CLAUDE.md"], file);

  assert.deepEqual([...loadPermanentlyIgnored("/repo", file)].sort(), [
    "CLAUDE.md",
    "pkg/CLAUDE.md",
  ]);
});

test("a corrupt store degrades to empty rather than throwing", () => {
  const file = storeFile();
  writeFileSync(file, "{ not json", "utf8");
  assert.equal(loadPermanentlyIgnored("/repo", file).size, 0);
  // A subsequent add still succeeds, overwriting the corrupt file.
  addPermanentlyIgnored("/repo", ["CLAUDE.md"], file);
  assert.deepEqual([...loadPermanentlyIgnored("/repo", file)], ["CLAUDE.md"]);
});
