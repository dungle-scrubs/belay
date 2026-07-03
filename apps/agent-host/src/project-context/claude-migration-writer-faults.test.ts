import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { applyMigrationDecision } from "./claude-migration-writer";

/**
 * Fault injection for the writer's rollback contract (M6 GREEN "rollback-safe error handling"): the
 * shared atomic-write module is mocked so the POINTER write (the second file of a conversion) can be
 * made to throw, proving create removes its new AGENTS.md and merge restores the previous content -
 * a failure never leaves a half-converted pair behind. Kept in its own file so the mock never leaks
 * into the main writer suite.
 */

const faults = vi.hoisted(() => ({ failPointerWrites: false }));

vi.mock("@host/io/atomic-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@host/io/atomic-write")>();
  return {
    ...actual,
    writeFileAtomic: (path: string, content: string): number => {
      if (faults.failPointerWrites && path.endsWith("CLAUDE.md")) {
        throw new Error("simulated pointer write failure");
      }
      return actual.writeFileAtomic(path, content);
    },
  };
});

afterEach(() => {
  faults.failPointerWrites = false;
});

test("create rolls back its new AGENTS.md when the pointer rewrite fails, then a retry succeeds", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-writer-fault-"));
  writeFileSync(join(root, "CLAUDE.md"), "legacy body", "utf8");

  faults.failPointerWrites = true;
  assert.throws(
    () =>
      applyMigrationDecision(root, {
        claudePath: "CLAUDE.md",
        agentsPath: "AGENTS.md",
        action: "create",
      }),
    /simulated pointer write failure/,
  );
  assert.equal(existsSync(join(root, "AGENTS.md")), false, "the created AGENTS.md is rolled back");
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "legacy body", "CLAUDE.md untouched");

  faults.failPointerWrites = false;
  const retry = applyMigrationDecision(root, {
    claudePath: "CLAUDE.md",
    agentsPath: "AGENTS.md",
    action: "create",
  });
  assert.equal(retry.kind, "created", "the retry converts cleanly from the original state");
  const markers = readFileSync(join(root, "AGENTS.md"), "utf8").match(/BEGIN migrated/g) ?? [];
  assert.equal(markers.length, 1, "exactly one migrated section after the retry");
});

test("merge restores the previous AGENTS.md when the pointer rewrite fails, then a retry succeeds", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-writer-fault-"));
  writeFileSync(join(root, "CLAUDE.md"), "body to merge", "utf8");
  writeFileSync(join(root, "AGENTS.md"), "# Existing\n", "utf8");

  faults.failPointerWrites = true;
  assert.throws(
    () =>
      applyMigrationDecision(root, {
        claudePath: "CLAUDE.md",
        agentsPath: "AGENTS.md",
        action: "merge",
      }),
    /simulated pointer write failure/,
  );
  assert.equal(
    readFileSync(join(root, "AGENTS.md"), "utf8"),
    "# Existing\n",
    "the pre-merge AGENTS.md content is restored",
  );

  faults.failPointerWrites = false;
  const retry = applyMigrationDecision(root, {
    claudePath: "CLAUDE.md",
    agentsPath: "AGENTS.md",
    action: "merge",
  });
  assert.equal(retry.kind, "merged");
  const merged = readFileSync(join(root, "AGENTS.md"), "utf8");
  const markers = merged.match(/BEGIN migrated/g) ?? [];
  assert.equal(markers.length, 1, "exactly one migrated section after the retry");
});
