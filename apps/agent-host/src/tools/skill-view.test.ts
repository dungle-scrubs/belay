import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { buildSkillRegistry, type SkillRoot } from "../skills";
import { resolveSkillView } from "./skill-view";

/**
 * D-075 M4: the `skill_view` resolver - which single skill body to load by id, or why not. Driven
 * with temp-dir fixtures + a real registry: one-body loading, unknown id, disabled id, malformed
 * (parse-diagnostic) id, and available-over-shadowed precedence. Interpolation gating inside the
 * loaded body is covered separately by skills.test.ts (expandSkill, which this tool delegates to).
 */

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function roots(): { project: SkillRoot; global: SkillRoot } {
  const base = mkdtempSync(join(tmpdir(), "trevor-skillview-"));
  temps.push(base);
  return {
    project: { kind: "project", dir: join(base, "project", ".agents", "skills") },
    global: { kind: "global", dir: join(base, "global", ".agents", "skills") },
  };
}

function writeSkill(
  root: SkillRoot,
  id: string,
  frontmatter: Record<string, string | boolean>,
  body = "do it",
): void {
  const dir = join(root.dir, id);
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join("\n");
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n${body}`);
}

test("resolves exactly the one named skill, with a provenance header", () => {
  const { project } = roots();
  writeSkill(project, "deploy", { name: "Deploy", description: "ship it" });
  writeSkill(project, "lint", { name: "Lint", description: "tidy it" });
  const registry = buildSkillRegistry([project]);

  const res = resolveSkillView(registry, "deploy");
  assert.equal(res.kind, "body");
  assert.ok(res.kind === "body");
  assert.equal(res.entry.id, "deploy", "exactly the one asked for - no neighbours");
  assert.match(res.header, /# Deploy \(deploy\) \[project\]/);
});

test("a whitespace-padded id is trimmed before lookup", () => {
  const { project } = roots();
  writeSkill(project, "deploy", { name: "Deploy", description: "ship it" });
  const res = resolveSkillView(buildSkillRegistry([project]), "  deploy  ");
  assert.equal(res.kind, "body");
});

test("an unknown id is a structured not-found that lists the available ids", () => {
  const { project } = roots();
  writeSkill(project, "deploy", { name: "Deploy", description: "ship it" });
  const res = resolveSkillView(buildSkillRegistry([project]), "nope");
  assert.equal(res.kind, "not-found");
  assert.ok(res.kind === "not-found");
  assert.match(res.message, /unknown skill "nope"/);
  assert.match(res.message, /Available: deploy/);
});

test("a disabled id is reported as disabled, not loaded", () => {
  const { project } = roots();
  writeSkill(project, "wip", { name: "WIP", description: "x", disabled: true });
  const res = resolveSkillView(buildSkillRegistry([project]), "wip");
  assert.equal(res.kind, "disabled");
  assert.ok(res.kind === "disabled");
  assert.match(res.message, /disabled/);
});

test("a malformed id (directory without SKILL.md) returns a parse diagnostic with its path", () => {
  const { project } = roots();
  mkdirSync(join(project.dir, "broken"), { recursive: true });
  const res = resolveSkillView(buildSkillRegistry([project]), "broken");
  assert.equal(res.kind, "malformed");
  assert.ok(res.kind === "malformed");
  assert.match(res.message, /no readable SKILL\.md/);
  assert.ok(res.message.includes("broken"), "the diagnostic names the path");
});

test("viewing a shadowed id loads the SELECTED (project) body, never the shadowed global one", () => {
  const { project, global } = roots();
  writeSkill(project, "deploy", { name: "Deploy (local)", description: "project deploy" });
  writeSkill(global, "deploy", { name: "Deploy (global)", description: "global deploy" });
  const res = resolveSkillView(buildSkillRegistry([project, global]), "deploy");
  assert.equal(res.kind, "body");
  assert.ok(res.kind === "body");
  assert.equal(res.entry.rootKind, "project", "the project entry wins");
  assert.equal(res.entry.status, "available", "the shadowed global entry is not selected");
  assert.match(res.header, /Deploy \(local\)/);
});
