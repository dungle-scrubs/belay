import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { discoverClaudeMigrations } from "./claude-migration";
import { applyMigrationDecision } from "./claude-migration-writer";

function tree(): string {
  return mkdtempSync(join(tmpdir(), "claude-writer-"));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("create builds a sibling AGENTS.md from the CLAUDE.md body with a provenance header", () => {
  const root = tree();
  write(join(root, "CLAUDE.md"), "# House rules\n\nAlways run the linter.");

  const outcome = applyMigrationDecision(root, {
    claudePath: "CLAUDE.md",
    agentsPath: "AGENTS.md",
    action: "create",
  });

  assert.equal(outcome.kind, "created");
  assert.equal(outcome.pointerWritten, true);
  const agents = read(join(root, "AGENTS.md"));
  assert.match(agents, /Migrated from CLAUDE\.md/i, "carries a provenance header");
  assert.match(agents, /Always run the linter\./, "preserves the CLAUDE.md body");
});

test("create rewrites the original CLAUDE.md into an idempotent pointer", () => {
  const root = tree();
  write(join(root, "CLAUDE.md"), "legacy body");

  applyMigrationDecision(root, {
    claudePath: "CLAUDE.md",
    agentsPath: "AGENTS.md",
    action: "create",
  });

  // The rewritten CLAUDE.md is recognized as a pointer, so re-discovery does not re-propose it.
  const inventory = discoverClaudeMigrations(root);
  const item = inventory.items.find((i) => i.claudePath === "CLAUDE.md");
  assert.equal(item?.pointer, true, "the rewritten CLAUDE.md is a pointer");
  assert.deepEqual(inventory.proposalItems, [], "the converted file is not re-proposed");
});

test("merge appends a clearly-marked migrated section without losing existing AGENTS.md content", () => {
  const root = tree();
  write(join(root, "apps", "CLAUDE.md"), "Legacy nested instructions.");
  write(join(root, "apps", "AGENTS.md"), "# Existing\n\nKeep this content.");

  const outcome = applyMigrationDecision(root, {
    claudePath: "apps/CLAUDE.md",
    agentsPath: "apps/AGENTS.md",
    action: "merge",
  });

  assert.equal(outcome.kind, "merged");
  const agents = read(join(root, "apps", "AGENTS.md"));
  assert.match(agents, /Keep this content\./, "existing content is preserved");
  assert.match(agents, /Legacy nested instructions\./, "migrated body is appended");
  assert.match(agents, /BEGIN migrated from CLAUDE\.md/, "the migrated section is clearly marked");
});

test("merge is idempotent: re-running does not append the section twice", () => {
  const root = tree();
  write(join(root, "CLAUDE.md"), "Body to merge.");
  write(join(root, "AGENTS.md"), "# Existing");

  applyMigrationDecision(root, {
    claudePath: "CLAUDE.md",
    agentsPath: "AGENTS.md",
    action: "merge",
  });
  const afterFirst = read(join(root, "AGENTS.md"));
  // A second merge (e.g. the pointer somehow reverted) must not duplicate the marked section.
  write(join(root, "CLAUDE.md"), "Body to merge.");
  const second = applyMigrationDecision(root, {
    claudePath: "CLAUDE.md",
    agentsPath: "AGENTS.md",
    action: "merge",
  });

  assert.equal(second.kind, "skipped", "an already-merged file is skipped");
  const markers = afterFirst.match(/BEGIN migrated from CLAUDE\.md/g) ?? [];
  assert.equal(markers.length, 1, "exactly one migrated section");
});

test("re-running create over an already-converted pointer is an idempotent no-op", () => {
  const root = tree();
  write(join(root, "CLAUDE.md"), "legacy body");

  const first = applyMigrationDecision(root, {
    claudePath: "CLAUDE.md",
    agentsPath: "AGENTS.md",
    action: "create",
  });
  const agentsAfterFirst = read(join(root, "AGENTS.md"));
  // The pointer now sits where CLAUDE.md was; a second create must not re-ingest it.
  const second = applyMigrationDecision(root, {
    claudePath: "CLAUDE.md",
    agentsPath: "AGENTS.md",
    action: "create",
  });

  assert.equal(first.kind, "created");
  assert.equal(second.kind, "skipped", "the pointer is recognized and skipped");
  assert.equal(read(join(root, "AGENTS.md")), agentsAfterFirst, "AGENTS.md is unchanged");
});

test("an atomic write leaves no temp files behind", () => {
  const root = tree();
  write(join(root, "CLAUDE.md"), "legacy body");

  applyMigrationDecision(root, {
    claudePath: "CLAUDE.md",
    agentsPath: "AGENTS.md",
    action: "create",
  });

  const stray = readdirSync(root).filter((name) => name.includes("trevor-tmp"));
  assert.deepEqual(stray, [], "no staging temp files remain in the tree");
});

test("leave and ignore actions never write files", () => {
  const root = tree();
  write(join(root, "CLAUDE.md"), "untouched");

  for (const action of ["leave", "ignore-once", "ignore-permanent"] as const) {
    const outcome = applyMigrationDecision(root, {
      claudePath: "CLAUDE.md",
      agentsPath: "AGENTS.md",
      action,
    });
    assert.equal(outcome.pointerWritten, false);
    assert.equal(outcome.bytesWritten, 0);
  }
  assert.equal(read(join(root, "CLAUDE.md")), "untouched", "CLAUDE.md is unchanged");
});
