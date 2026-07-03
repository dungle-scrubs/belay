import assert from "node:assert/strict";
import { test } from "vitest";
import type { ContextReport, ContextRuleSource } from "./agents-md";
import type { ClaudeMigrationInventory, ClaudeMigrationItem } from "./claude-migration";
import { collectContextDiagnostics, formatContextDiagnostics } from "./context-diagnostics";

function report(over: Partial<ContextReport>): ContextReport {
  return {
    text: over.text ?? "",
    files: over.files ?? [],
    scopes: over.scopes ?? [],
    bytesUsed: over.bytesUsed ?? 0,
    bytesDropped: over.bytesDropped ?? 0,
    ruleSources: over.ruleSources ?? [],
    truncated: over.truncated ?? false,
  };
}

function ruleSource(
  path: string,
  inclusionReason: ContextRuleSource["inclusionReason"],
): ContextRuleSource {
  return { bytes: 100, folder: undefined, inclusionReason, metadata: {}, path };
}

function claudeItem(
  over: Partial<ClaudeMigrationItem> & Pick<ClaudeMigrationItem, "claudePath">,
): ClaudeMigrationItem {
  return {
    agentsPath: over.agentsPath ?? "AGENTS.md",
    claudePath: over.claudePath,
    needsProposal: over.needsProposal ?? true,
    pointer: over.pointer ?? false,
    preview: over.preview ?? "body",
    siblingAgentsExists: over.siblingAgentsExists ?? false,
  };
}

function inventory(items: readonly ClaudeMigrationItem[]): ClaudeMigrationInventory {
  return { items, proposalItems: items.filter((i) => i.needsProposal) };
}

test("diagnostics separate AGENTS.md files from .trevor/rules and count inclusion reasons", () => {
  const diag = collectContextDiagnostics(
    report({
      files: [
        "/w/AGENTS.md",
        "/w/apps/AGENTS.md",
        "/w/.trevor/rules/a.md",
        "/w/.trevor/rules/b.md",
      ],
      scopes: ["project", "trevor-rule", "below-cwd-rule"],
      bytesUsed: 4096,
      ruleSources: [
        ruleSource("/w/.trevor/rules/a.md", "always"),
        ruleSource("/w/.trevor/rules/b.md", "file-access"),
      ],
    }),
    inventory([]),
    new Set(),
  );

  assert.equal(diag.agentsFiles, 2, "the two AGENTS.md files are counted apart from rules");
  assert.equal(diag.rulesTotal, 2);
  assert.equal(diag.rulesAlways, 1);
  assert.equal(diag.rulesScoped, 1);
  assert.equal(diag.bytesUsed, 4096);
});

test("diagnostics distinguish detected CLAUDE.md, pointers, to-migrate, and ignored", () => {
  const items = [
    claudeItem({ claudePath: "CLAUDE.md", needsProposal: true }),
    claudeItem({ claudePath: "old/CLAUDE.md", needsProposal: false, pointer: true }),
    claudeItem({ claudePath: "pkg/CLAUDE.md", needsProposal: true }),
  ];
  const diag = collectContextDiagnostics(
    report({ files: ["/w/AGENTS.md"] }),
    inventory(items),
    new Set(["pkg/CLAUDE.md"]),
  );

  assert.equal(diag.claudeDetected, 3);
  assert.equal(diag.claudePointers, 1);
  assert.equal(diag.claudeToMigrate, 1, "only the non-pointer, non-ignored file needs migration");
  assert.equal(diag.claudeIgnored, 1);
  assert.equal(
    diag.requiredResponsePending,
    true,
    "a pending migration flags required-response state",
  );
});

test("bytes dropped and truncation are surfaced, never silent", () => {
  const diag = collectContextDiagnostics(
    report({ files: ["/w/AGENTS.md"], bytesUsed: 32768, bytesDropped: 512, truncated: true }),
    inventory([]),
    new Set(),
  );
  const lines = formatContextDiagnostics(diag);
  assert.match(lines.context ?? "", /truncated/);
  assert.match(lines.context ?? "", /512/);
});

test("the formatted CLAUDE.md line appears only when files are detected", () => {
  const none = formatContextDiagnostics(
    collectContextDiagnostics(report({ files: ["/w/AGENTS.md"] }), inventory([]), new Set()),
  );
  assert.equal(none.claudeMd, undefined, "no CLAUDE.md line when nothing is detected");

  const some = formatContextDiagnostics(
    collectContextDiagnostics(
      report({ files: ["/w/AGENTS.md"] }),
      inventory([claudeItem({ claudePath: "CLAUDE.md" })]),
      new Set(),
    ),
  );
  assert.match(some.claudeMd ?? "", /1 to migrate/);
  assert.match(some.claudeMd ?? "", /response required/);
});

test("diagnostics summarize by counts and never dump instruction or rule bodies (D-012)", () => {
  // The guard is meaningful because the COLLECTOR receives the bodies (the report text and the
  // migration previews below both carry the secret) - so the collected read model, not just the
  // formatter's lines, is asserted body-free.
  const secretBody = "SECRET RULE BODY: do the dangerous thing";
  const diag = collectContextDiagnostics(
    report({
      text: `### trevor-rule: /w/.trevor/rules/a.md\n${secretBody}`,
      files: ["/w/AGENTS.md", "/w/.trevor/rules/a.md"],
      ruleSources: [ruleSource("/w/.trevor/rules/a.md", "always")],
    }),
    inventory([claudeItem({ claudePath: "CLAUDE.md", preview: secretBody })]),
    new Set(),
  );

  assert.ok(
    !JSON.stringify(diag).includes(secretBody),
    "the collected diagnostics carry no rule/instruction body in any field",
  );
  for (const value of Object.values(formatContextDiagnostics(diag))) {
    assert.ok(
      !value.includes(secretBody),
      "ordinary diagnostics must not include rule/instruction bodies",
    );
  }
});
