import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrevorEventInput } from "@trevor/session";
import { Effect } from "effect";
import { afterEach, test, vi } from "vitest";
import { providerQuestionRuntime } from "../agent/provider-questions";
import { migrateClaudeTool } from "./migrate-claude";

/**
 * The tool is WIRING over `runClaudeMigrationFlow` + the provider-question runtime - these tests prove
 * that routing: the flow's summaries come back as the tool result, the proposal blocks through the
 * real runtime (tagged `claude_migration`), and no file is written before the answer resolves. The
 * orchestration semantics themselves live in claude-migration-flow.test.ts.
 */

afterEach(() => {
  providerQuestionRuntime.reset();
});

test("a cwd with nothing to migrate returns the flow's no-migrations summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrate-tool-"));
  const prev = process.cwd();
  process.chdir(root);
  try {
    const result = await Effect.runPromise(
      migrateClaudeTool.execute({}, { runId: "r", callId: "c" }),
    );
    assert.equal(result, "No CLAUDE.md files need migration.");
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the tool blocks on the runtime proposal and applies the answer through the flow", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrate-tool-"));
  writeFileSync(join(root, "CLAUDE.md"), "legacy body", "utf8");
  const prev = process.cwd();
  process.chdir(root);
  const emitted: TrevorEventInput[] = [];
  providerQuestionRuntime.configure((event) => emitted.push(event));
  try {
    const pending = Effect.runPromise(migrateClaudeTool.execute({}, { runId: "r", callId: "c" }));

    await vi.waitFor(() => {
      assert.equal(providerQuestionRuntime.pendingCount, 1);
    });
    assert.equal(existsSync(join(root, "AGENTS.md")), false, "no write before the answer");

    const requested = emitted.find((event) => event.type === "provider.question.requested");
    const payload = (requested?.payload ?? {}) as Record<string, unknown>;
    assert.equal(payload.adapter, "claude_migration", "the request is tagged as a migration");
    assert.equal(payload.toolName, "migrate_claude_md");

    providerQuestionRuntime.submitAnswer(String(payload.questionId ?? ""), {
      action: "accept",
      answer: "Create AGENTS.md",
      questions: [
        {
          id: "CLAUDE.md",
          answer: "Create AGENTS.md",
          selected: [{ id: "create", label: "Create AGENTS.md" }],
        },
      ],
    });

    const summary = await pending;
    assert.match(summary, /created AGENTS\.md from CLAUDE\.md/, "the flow's summary is the result");
    assert.equal(existsSync(join(root, "AGENTS.md")), true, "the create landed after the answer");
  } finally {
    process.chdir(prev);
    providerQuestionRuntime.reset();
    rmSync(root, { recursive: true, force: true });
  }
});
