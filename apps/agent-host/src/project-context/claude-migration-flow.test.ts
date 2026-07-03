import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderQuestionAnswer, ProviderQuestionContract } from "@trevor/session";
import { test } from "vitest";
import { runClaudeMigrationFlow } from "./claude-migration-flow";
import { loadPermanentlyIgnored } from "./claude-migration-ignores";

function tree(): { readonly root: string; readonly ignoresFile: string } {
  const root = mkdtempSync(join(tmpdir(), "claude-flow-"));
  return { root, ignoresFile: join(root, ".ignores.json") };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function accept(selections: Record<string, string>): ProviderQuestionAnswer {
  return {
    action: "accept",
    answer: "",
    questions: Object.entries(selections).map(([id, action]) => ({
      id,
      answer: action,
      selected: [{ id: action, label: action }],
    })),
  };
}

test("a workspace with no CLAUDE.md never asks and writes nothing", async () => {
  const { root, ignoresFile } = tree();
  write(join(root, "AGENTS.md"), "# existing");
  let asked = 0;

  const result = await runClaudeMigrationFlow(
    root,
    async () => {
      asked += 1;
      return { action: "cancel" };
    },
    { ignoresFile },
  );

  assert.equal(asked, 0, "no proposal is raised when nothing needs migration");
  assert.equal(result.status, "no-migrations");
  assert.deepEqual(result.outcomes, []);
});

test("the migration blocks on the user response before any file is written (M5.1)", async () => {
  const { root, ignoresFile } = tree();
  write(join(root, "CLAUDE.md"), "# rules\n\nRun tests.");
  const agentsAbs = join(root, "AGENTS.md");

  let resolveAnswer: (a: ProviderQuestionAnswer) => void = () => {};
  const pending = new Promise<ProviderQuestionAnswer>((r) => {
    resolveAnswer = r;
  });
  let sawContract: ProviderQuestionContract | undefined;

  const flow = runClaudeMigrationFlow(
    root,
    (contract) => {
      sawContract = contract;
      return pending;
    },
    { ignoresFile },
  );

  // Give the flow a chance to reach the ask; it must not have written anything yet.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sawContract, "the proposal was raised");
  assert.equal(existsSync(agentsAbs), false, "no AGENTS.md is written while awaiting the answer");

  resolveAnswer(accept({ "CLAUDE.md": "create" }));
  const result = await flow;

  assert.equal(result.status, "answered");
  assert.equal(existsSync(agentsAbs), true, "AGENTS.md is written only after the answer");
  assert.match(readFileSync(agentsAbs, "utf8"), /Run tests\./);
});

test("a declined proposal leaves every file unchanged", async () => {
  const { root, ignoresFile } = tree();
  write(join(root, "CLAUDE.md"), "legacy");

  const result = await runClaudeMigrationFlow(root, async () => ({ action: "decline" }), {
    ignoresFile,
  });

  assert.equal(result.status, "declined");
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "legacy", "CLAUDE.md untouched");
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
});

test("grouped files take different explicit actions, and ignore-permanent persists (M5.5/M5.4)", async () => {
  const { root, ignoresFile } = tree();
  write(join(root, "CLAUDE.md"), "root rules");
  write(join(root, "pkg", "CLAUDE.md"), "pkg rules");

  const result = await runClaudeMigrationFlow(
    root,
    async () => accept({ "CLAUDE.md": "create", "pkg/CLAUDE.md": "ignore-permanent" }),
    { ignoresFile },
  );

  assert.equal(result.status, "answered");
  assert.equal(existsSync(join(root, "AGENTS.md")), true, "the create action ran");
  assert.equal(
    existsSync(join(root, "pkg", "AGENTS.md")),
    false,
    "the ignored file was not converted",
  );
  assert.deepEqual([...loadPermanentlyIgnored(root, ignoresFile)], ["pkg/CLAUDE.md"]);
});

test("permanently-ignored files are not re-proposed on a later run", async () => {
  const { root, ignoresFile } = tree();
  write(join(root, "pkg", "CLAUDE.md"), "pkg rules");
  // First run: ignore it permanently.
  await runClaudeMigrationFlow(root, async () => accept({ "pkg/CLAUDE.md": "ignore-permanent" }), {
    ignoresFile,
  });

  // Second run: the ignored file must not surface a proposal at all.
  let asked = 0;
  const second = await runClaudeMigrationFlow(
    root,
    async () => {
      asked += 1;
      return { action: "cancel" };
    },
    { ignoresFile },
  );

  assert.equal(asked, 0, "the permanently-ignored file is filtered before the proposal");
  assert.equal(second.status, "no-migrations");
});
