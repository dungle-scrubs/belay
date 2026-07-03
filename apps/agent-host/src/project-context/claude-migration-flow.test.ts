import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderQuestionAnswer, ProviderQuestionContract } from "@trevor/session";
import { Effect } from "effect";
import { test } from "vitest";
import {
  type ClaudeMigrationFlowOptions,
  type MigrationAsker,
  runClaudeMigrationFlow,
} from "./claude-migration-flow";
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

const run = (cwd: string, ask: MigrationAsker, opts: ClaudeMigrationFlowOptions) =>
  Effect.runPromise(runClaudeMigrationFlow(cwd, ask, opts));

test("a workspace with no CLAUDE.md never asks and writes nothing", async () => {
  const { root, ignoresFile } = tree();
  write(join(root, "AGENTS.md"), "# existing");
  let asked = 0;

  const result = await run(
    root,
    () =>
      Effect.sync(() => {
        asked += 1;
        return { action: "cancel" } as const;
      }),
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

  let releaseAnswer: (a: ProviderQuestionAnswer) => void = () => {};
  const pendingAnswer = new Promise<ProviderQuestionAnswer>((resolve) => {
    releaseAnswer = resolve;
  });
  // Event-driven gate: the ask stub resolves this promise the moment the flow reaches it, so the
  // test never sleeps a fixed duration hoping the flow got there.
  let markAsked: () => void = () => {};
  const asked = new Promise<void>((resolve) => {
    markAsked = resolve;
  });
  let sawContract: ProviderQuestionContract | undefined;

  const flow = run(
    root,
    (contract) => {
      sawContract = contract;
      markAsked();
      return Effect.promise(() => pendingAnswer);
    },
    { ignoresFile },
  );

  await asked;
  assert.ok(sawContract, "the proposal was raised");
  assert.equal(existsSync(agentsAbs), false, "no AGENTS.md is written while awaiting the answer");

  releaseAnswer(accept({ "CLAUDE.md": "create" }));
  const result = await flow;

  assert.equal(result.status, "answered");
  assert.equal(existsSync(agentsAbs), true, "AGENTS.md is written only after the answer");
  assert.match(readFileSync(agentsAbs, "utf8"), /Run tests\./);
});

test("a declined proposal leaves every file unchanged", async () => {
  const { root, ignoresFile } = tree();
  write(join(root, "CLAUDE.md"), "legacy");

  const result = await run(root, () => Effect.succeed({ action: "decline" } as const), {
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

  const result = await run(
    root,
    () => Effect.succeed(accept({ "CLAUDE.md": "create", "pkg/CLAUDE.md": "ignore-permanent" })),
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
  await run(root, () => Effect.succeed(accept({ "pkg/CLAUDE.md": "ignore-permanent" })), {
    ignoresFile,
  });

  // Second run: the ignored file must not surface a proposal at all.
  let asked = 0;
  const second = await run(
    root,
    () =>
      Effect.sync(() => {
        asked += 1;
        return { action: "cancel" } as const;
      }),
    { ignoresFile },
  );

  assert.equal(asked, 0, "the permanently-ignored file is filtered before the proposal");
  assert.equal(second.status, "no-migrations");
});

test("a per-file failure is contained: earlier files apply, later files still get their action", async () => {
  const { root, ignoresFile } = tree();
  write(join(root, "CLAUDE.md"), "root rules");
  write(join(root, "b", "CLAUDE.md"), "b rules");
  write(join(root, "c", "CLAUDE.md"), "c rules");

  const result = await run(
    root,
    () =>
      Effect.sync(() => {
        // Simulate the failure mode: b's CLAUDE.md disappears between the proposal and the answer,
        // so applying its create throws mid-batch.
        rmSync(join(root, "b", "CLAUDE.md"));
        return accept({
          "CLAUDE.md": "create",
          "b/CLAUDE.md": "create",
          "c/CLAUDE.md": "ignore-permanent",
        });
      }),
    { ignoresFile },
  );

  assert.equal(result.status, "answered");
  const kinds = new Map(result.outcomes.map((outcome) => [outcome.claudePath, outcome.kind]));
  assert.equal(kinds.get("CLAUDE.md"), "created", "the file before the failure applied");
  assert.equal(kinds.get("b/CLAUDE.md"), "failed", "the failing file is reported, not thrown");
  assert.equal(
    kinds.get("c/CLAUDE.md"),
    "ignored-permanent",
    "the file after the failure still got its explicit action",
  );
  assert.equal(existsSync(join(root, "AGENTS.md")), true, "the earlier create landed");
  assert.deepEqual(
    [...loadPermanentlyIgnored(root, ignoresFile)],
    ["c/CLAUDE.md"],
    "the ignore-permanent decision persisted despite the earlier failure",
  );
  assert.match(result.summary, /FAILED b\/CLAUDE\.md/, "the summary names the failed file");
});
