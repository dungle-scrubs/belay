import assert from "node:assert/strict";
import { validateContract } from "@trevor/session";
import { test } from "vitest";
import type { ClaudeMigrationItem } from "./claude-migration";
import {
  buildMigrationProposalContract,
  MIGRATION_ACTION_LABELS,
  resolveMigrationDecisions,
} from "./claude-migration-proposal";

function item(
  over: Partial<ClaudeMigrationItem> & Pick<ClaudeMigrationItem, "claudePath">,
): ClaudeMigrationItem {
  return {
    agentsPath: over.agentsPath ?? over.claudePath.replace(/CLAUDE\.md$/u, "AGENTS.md"),
    claudePath: over.claudePath,
    needsProposal: over.needsProposal ?? true,
    pointer: over.pointer ?? false,
    preview: over.preview ?? "legacy instructions",
    siblingAgentsExists: over.siblingAgentsExists ?? false,
  };
}

test("a proposal offers create/leave/ignore choices when no sibling AGENTS.md exists", () => {
  const contract = buildMigrationProposalContract([item({ claudePath: "CLAUDE.md" })]);

  assert.deepEqual(validateContract(contract), [], "the proposal contract is structurally valid");
  const [question] = contract.questions;
  assert.equal(question?.id, "CLAUDE.md");
  const ids = question?.choices.map((c) => c.id);
  assert.deepEqual(ids, ["create", "leave", "ignore-once", "ignore-permanent"]);
  // Merge is not offered without a sibling to merge into; create is recommended.
  assert.equal(
    question?.choices.find((c) => c.recommended)?.id,
    "create",
    "create is the recommended action without a sibling",
  );
});

test("a proposal offers merge instead of create when a sibling AGENTS.md exists", () => {
  const contract = buildMigrationProposalContract([
    item({ claudePath: "apps/web/CLAUDE.md", siblingAgentsExists: true }),
  ]);

  const [question] = contract.questions;
  const ids = question?.choices.map((c) => c.id);
  assert.deepEqual(ids, ["merge", "leave", "ignore-once", "ignore-permanent"]);
  assert.equal(question?.choices.find((c) => c.recommended)?.id, "merge");
  // The preview and sibling state are surfaced to the user.
  assert.match(question?.question ?? "", /apps\/web\/CLAUDE\.md/);
  assert.match(question?.question ?? "", /apps\/web\/AGENTS\.md/);
});

test("each choice label is a human-readable action from the shared label map", () => {
  const contract = buildMigrationProposalContract([item({ claudePath: "CLAUDE.md" })]);
  for (const choice of contract.questions[0]?.choices ?? []) {
    assert.equal(
      choice.label,
      MIGRATION_ACTION_LABELS[choice.id as keyof typeof MIGRATION_ACTION_LABELS],
    );
  }
});

test("grouped nested proposals carry one independently-answerable question per file", () => {
  const items = [
    item({ claudePath: "CLAUDE.md" }),
    item({ claudePath: "apps/web/CLAUDE.md", siblingAgentsExists: true }),
  ];
  const contract = buildMigrationProposalContract(items);

  assert.equal(contract.questions.length, 2);
  assert.deepEqual(
    contract.questions.map((q) => q.id),
    ["CLAUDE.md", "apps/web/CLAUDE.md"],
  );
  assert.deepEqual(validateContract(contract), []);
});

test("resolveMigrationDecisions maps each answered file back to its explicit action", () => {
  const items = [
    item({ claudePath: "CLAUDE.md" }),
    item({ claudePath: "apps/web/CLAUDE.md", siblingAgentsExists: true }),
  ];
  const decisions = resolveMigrationDecisions(items, {
    action: "accept",
    answer: "",
    questions: [
      { id: "CLAUDE.md", answer: "Create AGENTS.md", selected: [{ id: "create", label: "x" }] },
      {
        id: "apps/web/CLAUDE.md",
        answer: "Ignore permanently",
        selected: [{ id: "ignore-permanent", label: "x" }],
      },
    ],
  });

  assert.deepEqual(decisions, [
    { claudePath: "CLAUDE.md", agentsPath: "AGENTS.md", action: "create" },
    {
      claudePath: "apps/web/CLAUDE.md",
      agentsPath: "apps/web/AGENTS.md",
      action: "ignore-permanent",
    },
  ]);
});

test("a declined or cancelled proposal resolves every file to leave-unchanged", () => {
  const items = [item({ claudePath: "CLAUDE.md" })];
  for (const action of ["decline", "cancel"] as const) {
    const decisions = resolveMigrationDecisions(items, { action });
    assert.deepEqual(decisions, [
      { claudePath: "CLAUDE.md", agentsPath: "AGENTS.md", action: "leave" },
    ]);
  }
});

test("an unanswered file in an accepted group falls back to leave-unchanged", () => {
  const items = [item({ claudePath: "CLAUDE.md" }), item({ claudePath: "pkg/CLAUDE.md" })];
  const decisions = resolveMigrationDecisions(items, {
    action: "accept",
    answer: "",
    questions: [
      { id: "CLAUDE.md", answer: "Leave unchanged", selected: [{ id: "leave", label: "x" }] },
    ],
  });

  assert.equal(decisions.find((d) => d.claudePath === "pkg/CLAUDE.md")?.action, "leave");
});
