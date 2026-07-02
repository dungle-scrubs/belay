import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { collectTrevorRuleSources } from "./rules";
import { CONTEXT_SOURCE_KINDS } from "./sources";

function tree(): string {
  return mkdtempSync(join(tmpdir(), "trevor-rules-"));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

test("collects .trevor/rules markdown files as typed context sources", () => {
  const root = tree();
  write(
    join(root, ".trevor", "rules", "review.md"),
    [
      "---",
      "id: review",
      "title: Review guide",
      "description: How to review changes",
      "inclusion: always",
      "priority: 10",
      "globs:",
      '  - "**/*.ts"',
      "---",
      "Run tests before claiming completion.",
    ].join("\n"),
  );

  const report = collectTrevorRuleSources(root);

  assert.equal(report.diagnostics.length, 0);
  assert.equal(report.rules.length, 1);
  const [rule] = report.rules;
  assert.equal(rule?.kind, CONTEXT_SOURCE_KINDS.trevorRule);
  assert.equal(rule?.metadata.id, "review");
  assert.equal(rule?.metadata.title, "Review guide");
  assert.equal(rule?.metadata.description, "How to review changes");
  assert.equal(rule?.metadata.inclusion, "always");
  assert.equal(rule?.metadata.priority, 10);
  assert.deepEqual(rule?.metadata.globs, ["**/*.ts"]);
  assert.match(rule?.content ?? "", /Run tests before claiming completion\./);
});

test("applies nearest folder metadata as provenance and defaults for rules", () => {
  const root = tree();
  write(
    join(root, ".trevor", "rules", "apps", "metadata.yaml"),
    [
      "title: Apps folder",
      "description: Rules for app packages",
      "priority: 5",
      "globs:",
      '  - "apps/**"',
    ].join("\n"),
  );
  write(
    join(root, ".trevor", "rules", "apps", "react.md"),
    ["---", "id: react", "inclusion: scoped", "---", "Keep React behavior tested."].join("\n"),
  );

  const report = collectTrevorRuleSources(root);
  const [rule] = report.rules;

  assert.equal(rule?.folder?.title, "Apps folder");
  assert.equal(rule?.folder?.description, "Rules for app packages");
  assert.equal(rule?.metadata.priority, 5);
  assert.deepEqual(rule?.metadata.globs, ["apps/**"]);
  assert.equal(rule?.metadata.inclusion, "scoped");
});

test("returns diagnostics for malformed metadata, duplicate ids, disabled rules, and unknown fields", () => {
  const root = tree();
  write(
    join(root, ".trevor", "rules", "bad.md"),
    ["---", "id: duplicate", "unknown: nope", "enabled: true", "---", "Bad metadata."].join("\n"),
  );
  write(
    join(root, ".trevor", "rules", "disabled.md"),
    ["---", "id: disabled", "enabled: false", "---", "Do not load."].join("\n"),
  );
  write(
    join(root, ".trevor", "rules", "duplicate.md"),
    ["---", "id: duplicate", "---", "Duplicate id."].join("\n"),
  );
  write(join(root, ".trevor", "rules", "malformed.md"), "---\nid: [\n---\nMalformed.");

  const report = collectTrevorRuleSources(root);
  const codes = report.diagnostics.map((diagnostic) => diagnostic.code);

  assert.ok(codes.includes("unknown_metadata"));
  assert.ok(codes.includes("disabled_rule"));
  assert.ok(codes.includes("duplicate_rule_id"));
  assert.ok(codes.includes("invalid_frontmatter"));
  assert.ok(!report.rules.some((rule) => rule.metadata.id === "disabled"));
});
