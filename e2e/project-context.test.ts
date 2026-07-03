import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildInitProposal,
  ContextRegistry,
  collectEagerSources,
  renderContext,
} from "@trevor/agent-host/testing";
import { afterEach, test } from "vitest";

/**
 * S-E2E project context (hermetic, plan 26 M8): exercises the real host context modules over throwaway
 * temp workspaces - eager AGENTS.md ordering, always/scoped `.trevor/rules`, lazy below-cwd loading on
 * file access, and the `/init` proposal - plus a regression proving that a workspace WITHOUT rules or
 * CLAUDE.md renders byte-for-byte the shipped D-080 context. No store is booted: this is the context
 * workflow half of the "hermetic context and migration workflows" gate.
 */

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "trevor-ctx-"));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** Index of a scope band in the report's precedence-ordered scope list. */
function scopeAt(scopes: readonly string[], scope: string): number {
  return scopes.indexOf(scope);
}

test("context ordering: project AGENTS.md, then always rule, then lazy below-cwd + scoped rule (M8.1/M8.2)", () => {
  const root = tree();
  write(join(root, "AGENTS.md"), "# Root guide\n\nRoot rule.");
  write(join(root, "apps", "AGENTS.md"), "# Apps guide\n\nApps rule.");
  write(
    join(root, ".trevor", "rules", "always.md"),
    "---\nid: always-rule\ninclusion: always\n---\nAlways body.",
  );
  write(
    join(root, ".trevor", "rules", "scoped.md"),
    "---\nid: scoped-rule\ninclusion: scoped\nglobs:\n  - apps/**\n---\nScoped body.",
  );

  const registry = new ContextRegistry();

  // Before any file access: the always rule loads with project context; the scoped rule does not.
  const before = registry.report(root, root);
  assert.ok(scopeAt(before.scopes, "project") >= 0, "the root AGENTS.md is eager");
  assert.ok(
    scopeAt(before.scopes, "project") < scopeAt(before.scopes, "trevor-rule"),
    "the always rule renders after project AGENTS.md",
  );
  assert.equal(
    scopeAt(before.scopes, "below-cwd"),
    -1,
    "no below-cwd AGENTS.md before file access",
  );
  assert.equal(scopeAt(before.scopes, "below-cwd-rule"), -1, "the scoped rule has not loaded yet");
  assert.ok(
    !before.text.includes("Scoped body."),
    "the scoped rule body is absent before its scope opens",
  );
  assert.ok(
    before.ruleSources.some((r) => r.inclusionReason === "always"),
    "the always rule carries its inclusion reason",
  );

  // Touching a file under apps/ lazily loads the below-cwd AGENTS.md AND the path-scoped rule.
  registry.noteFileAccess(join(root, "apps", "service.ts"), root);
  const after = registry.report(root, root);
  const order = ["project", "trevor-rule", "below-cwd", "below-cwd-rule"].map((s) =>
    scopeAt(after.scopes, s),
  );
  assert.ok(
    order.every((idx) => idx >= 0),
    `every context band is present, got ${after.scopes.join(", ")}`,
  );
  for (let i = 1; i < order.length; i += 1) {
    const prev = order[i - 1];
    const cur = order[i];
    assert.ok(
      prev !== undefined && cur !== undefined && cur > prev,
      `scopes stay in precedence order, got ${after.scopes.join(", ")}`,
    );
  }
  assert.ok(after.text.includes("Apps rule."), "the below-cwd AGENTS.md loaded on file access");
  assert.ok(
    after.text.includes("Scoped body."),
    "the path-scoped rule loaded on matching file access",
  );
});

test("/init drafts from real repo evidence: rules, nested AGENTS.md, and a merge proposal (M8.1)", () => {
  const root = tree();
  write(join(root, "AGENTS.md"), "# Root guide\n\nRoot rule.");
  write(join(root, "apps", "AGENTS.md"), "# Apps guide\n\nApps rule.");
  write(join(root, ".trevor", "rules", "always.md"), "---\ninclusion: always\n---\nAlways body.");
  write(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));

  const proposal = buildInitProposal(root);

  assert.equal(proposal.evidence.rules.length, 1, "the .trevor/rules file is inventoried");
  assert.deepEqual(
    [...proposal.evidence.existingAgents].sort(),
    ["AGENTS.md", "apps/AGENTS.md"],
    "root + nested AGENTS.md are discovered",
  );
  assert.equal(
    proposal.action,
    "merge",
    "an existing root AGENTS.md means a merge/refresh proposal",
  );
  assert.match(proposal.draft, /Trevor rules:/, "the draft points at the rules it found");
  assert.match(proposal.preview, /No files were written/, "the proposal is review-only");
});

test("regression: a workspace with no rules or CLAUDE.md renders byte-for-byte the D-080 context (M8.5/M8.6)", () => {
  const root = tree();
  write(join(root, "AGENTS.md"), "# Only agents\n\nJust this.");
  write(join(root, "nested", "AGENTS.md"), "# Nested\n\nNested only.");

  const registry = new ContextRegistry();
  const eager = registry.report(root, root);
  const baseline = renderContext(collectEagerSources({ cwd: root, workspaceRoot: root }));

  assert.equal(eager.text, baseline.text, "the eager render is byte-for-byte the pure D-080 path");
  assert.equal(eager.ruleSources.length, 0, "no rule sources when there are no rules");
  assert.match(
    eager.text,
    /Project context \(AGENTS\.md\)\./,
    "the intro is the plain AGENTS.md form",
  );
  assert.ok(!eager.text.includes(".trevor/rules"), "no rules mentioned when none exist");

  // Lazy below-cwd loading still works and injects no rule scopes.
  registry.noteFileAccess(join(root, "nested", "file.ts"), root);
  const after = registry.report(root, root);
  assert.ok(after.scopes.includes("below-cwd"), "the nested AGENTS.md loaded lazily");
  assert.equal(after.ruleSources.length, 0, "lazy loading injects no rule sources");
  assert.ok(after.text.includes("Nested only."), "the nested body is present after file access");
});
