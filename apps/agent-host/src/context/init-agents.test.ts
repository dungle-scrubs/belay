import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { AGENTS_FILE } from "./agents-md";
import { buildAgentsDraft, buildInitProposal, collectInitEvidence } from "./init-agents";

function tree(): string {
  return mkdtempSync(join(tmpdir(), "init-agents-"));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

test("/init evidence scan includes repo docs, package scripts, tests, AGENTS, rules, and CLAUDE inventory", () => {
  const root = tree();
  write(join(root, "README.md"), "# Demo");
  write(join(root, "docs", "setup.md"), "setup");
  write(
    join(root, "package.json"),
    JSON.stringify({ scripts: { lint: "biome check .", test: "vitest run" } }),
  );
  write(join(root, "vitest.config.ts"), "export default {};");
  write(join(root, "apps", "AGENTS.md"), "nested");
  write(join(root, ".trevor", "rules", "review.md"), "---\nid: review\n---\nRun tests.");
  write(join(root, "CLAUDE.md"), "legacy");
  write(join(root, "node_modules", "dep", "CLAUDE.md"), "ignored");

  const evidence = collectInitEvidence(root);

  assert.deepEqual(evidence.docs, ["README.md", "docs/setup.md"]);
  assert.equal(evidence.packageScripts.lint, "biome check .");
  assert.deepEqual(evidence.testConfigs, ["vitest.config.ts"]);
  assert.deepEqual(evidence.existingAgents, ["apps/AGENTS.md"]);
  assert.deepEqual(evidence.rules, [".trevor/rules/review.md"]);
  assert.deepEqual(evidence.claudeFiles, ["CLAUDE.md"]);
});

test("/init draft uses evidence-backed paths and commands instead of copying large docs", () => {
  const draft = buildAgentsDraft({
    claudeFiles: [],
    docs: ["README.md"],
    existingAgents: [],
    packageJson: "package.json",
    packageScripts: { lint: "biome check .", test: "vitest run" },
    rules: [],
    testConfigs: ["vitest.config.ts"],
  });

  assert.match(draft, /`README\.md`/);
  assert.match(draft, /`pnpm lint` - biome check \./);
  assert.match(draft, /`vitest\.config\.ts`/);
  assert.ok(!draft.includes("# Demo"), "the README body is not copied into AGENTS.md");
  assert.match(draft, /Prefer exact repository commands/);
});

test("/init proposal supports create, merge, no-op, and nested scoped proposal modes", () => {
  const createRoot = tree();
  write(join(createRoot, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  assert.equal(buildInitProposal(createRoot).action, "create");

  const mergeRoot = tree();
  write(join(mergeRoot, AGENTS_FILE), "Existing instructions.");
  assert.equal(buildInitProposal(mergeRoot).action, "merge");

  const noOpRoot = tree();
  const noOpDraft = buildAgentsDraft(collectInitEvidence(noOpRoot));
  write(join(noOpRoot, AGENTS_FILE), noOpDraft);
  assert.equal(buildInitProposal(noOpRoot).action, "noop");

  const nestedRoot = tree();
  write(join(nestedRoot, "apps", "web", "CLAUDE.md"), "web-only");
  const nested = buildInitProposal(nestedRoot);
  assert.deepEqual(nested.nestedScopedAgents, ["apps/web/AGENTS.md"]);
  assert.ok(nested.diff.some((line) => line.includes("apps/web/AGENTS.md")));
  assert.match(nested.preview, /Structured diff:/);
});

test("/init proposals are deterministic for identical evidence", () => {
  const root = tree();
  write(join(root, "README.md"), "# Demo");
  write(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));

  assert.deepEqual(buildInitProposal(root), buildInitProposal(root));
});
