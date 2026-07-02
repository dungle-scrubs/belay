import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { discoverClaudeMigrations, siblingAgentsPath } from "./claude-migration";

function tree(): string {
  return mkdtempSync(join(tmpdir(), "claude-migration-"));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

test("discovers root and nested CLAUDE.md files within the workspace only", () => {
  const root = tree();
  write(join(root, "CLAUDE.md"), "root");
  write(join(root, "apps", "web", "CLAUDE.md"), "web");
  write(join(root, "node_modules", "dep", "CLAUDE.md"), "ignored");
  write(join(root, ".git", "CLAUDE.md"), "ignored");

  const inventory = discoverClaudeMigrations(root);

  assert.deepEqual(
    inventory.items.map((item) => item.claudePath),
    ["CLAUDE.md", "apps/web/CLAUDE.md"],
  );
});

test("maps each CLAUDE.md file to sibling AGENTS.md state and bounded preview", () => {
  const root = tree();
  write(join(root, "apps", "api", "CLAUDE.md"), `${"x".repeat(700)}`);
  write(join(root, "apps", "api", "AGENTS.md"), "existing");

  const [item] = discoverClaudeMigrations(root).items;

  assert.equal(item?.claudePath, "apps/api/CLAUDE.md");
  assert.equal(item?.agentsPath, "apps/api/AGENTS.md");
  assert.equal(item?.siblingAgentsExists, true);
  assert.match(item?.preview ?? "", /truncated/);
  assert.equal(siblingAgentsPath("apps/api/CLAUDE.md"), "apps/api/AGENTS.md");
});

test("recognizes converted CLAUDE.md pointers and excludes them from proposal items", () => {
  const root = tree();
  write(join(root, "CLAUDE.md"), "Moved: use AGENTS.md as the source of truth.");
  write(join(root, "pkg", "CLAUDE.md"), "real legacy instructions");

  const inventory = discoverClaudeMigrations(root);

  assert.equal(inventory.items.find((item) => item.claudePath === "CLAUDE.md")?.pointer, true);
  assert.deepEqual(
    inventory.proposalItems.map((item) => item.claudePath),
    ["pkg/CLAUDE.md"],
  );
});
