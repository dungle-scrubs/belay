import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { buildSkillRegistry, type SkillRoot } from "./skills";
import { formatSkillsList } from "./tools/skills-list";

/**
 * D-075 M1/M3: the skill REGISTRY (every entry tagged available/shadowed/disabled/malformed +
 * provenance + triggers, nothing silently dropped) and the searchable skills_list formatter. Driven
 * with temp-dir fixtures - no global state.
 */

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function roots(): { project: SkillRoot; global: SkillRoot } {
  const base = mkdtempSync(join(tmpdir(), "trevor-skillreg-"));
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
  // Quote string values so a description containing a colon (e.g. "Triggers:") stays valid YAML.
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join("\n");
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n${body}`);
}

test("a project skill shadows a same-id global skill (both surface, with status)", () => {
  const { project, global } = roots();
  writeSkill(project, "deploy", { name: "Deploy (local)", description: "project deploy" });
  writeSkill(global, "deploy", { name: "Deploy (global)", description: "global deploy" });

  const registry = buildSkillRegistry([project, global]);
  const deploys = registry.filter((e) => e.id === "deploy");
  assert.equal(deploys.length, 2, "both the project and global entry are represented");
  assert.equal(deploys.find((e) => e.rootKind === "project")?.status, "available", "project wins");
  assert.equal(
    deploys.find((e) => e.rootKind === "global")?.status,
    "shadowed",
    "global is shadowed",
  );
});

test("a disabled skill is represented as disabled, not dropped", () => {
  const { project } = roots();
  writeSkill(project, "wip", { name: "WIP", description: "x", disabled: true });
  const entry = buildSkillRegistry([project]).find((e) => e.id === "wip");
  assert.equal(entry?.status, "disabled");
});

test("a directory with no SKILL.md is represented as malformed", () => {
  const { project } = roots();
  mkdirSync(join(project.dir, "broken"), { recursive: true });
  const entry = buildSkillRegistry([project]).find((e) => e.id === "broken");
  assert.equal(entry?.status, "malformed");
});

test("a disabled project skill leaves the global of that id available (no tombstone)", () => {
  const { project, global } = roots();
  writeSkill(project, "lint", { name: "Lint", description: "x", disabled: true });
  writeSkill(global, "lint", { name: "Lint", description: "the real lint" });
  const lints = buildSkillRegistry([project, global]).filter((e) => e.id === "lint");
  assert.equal(lints.find((e) => e.rootKind === "project")?.status, "disabled");
  assert.equal(lints.find((e) => e.rootKind === "global")?.status, "available", "global is usable");
});

test("triggers are extracted from the description tail", () => {
  const { project } = roots();
  writeSkill(project, "rfc", {
    name: "RFC",
    description: "Write an RFC. Triggers: rfc, design doc, spec",
  });
  const entry = buildSkillRegistry([project]).find((e) => e.id === "rfc");
  assert.equal(entry?.triggers, "rfc, design doc, spec");
});

test("every registry record is a skill row in the skills-only first cut (no command/agent leakage)", () => {
  const { project, global } = roots();
  writeSkill(project, "deploy", { name: "Deploy", description: "ship" }); // available
  writeSkill(project, "wip", { name: "WIP", description: "x", disabled: true }); // disabled
  writeSkill(global, "deploy", { name: "Deploy (global)", description: "global" }); // shadowed
  mkdirSync(join(project.dir, "broken"), { recursive: true }); // malformed (no SKILL.md)

  const registry = buildSkillRegistry([project, global]);
  assert.ok(
    registry.length >= 4,
    "available + disabled + shadowed + malformed are all represented",
  );
  // The discriminant is stamped on EVERY record regardless of status, and nothing but "skill"
  // appears - so a later command/agent slice can join the same registry (D-075 M6) without these
  // rows leaking a bogus resource type into the skills-only cut.
  assert.ok(
    registry.every((e) => e.resourceType === "skill"),
    "no non-skill rows leak into the skills-only registry",
  );
  assert.deepEqual(
    [...new Set(registry.map((e) => e.resourceType))],
    ["skill"],
    "exactly one resource type in the first cut",
  );
});

test("formatSkillsList searches metadata, defaults to available only, and bounds with truncation", () => {
  const { project } = roots();
  writeSkill(project, "deploy", {
    name: "Deploy",
    description: "ship the app. Triggers: deploy, release",
  });
  writeSkill(project, "lint", { name: "Lint", description: "run the linter" });
  writeSkill(project, "wip", { name: "WIP", description: "deploy thing", disabled: true });
  const registry = buildSkillRegistry([project]);

  const all = formatSkillsList(registry, undefined, 20);
  assert.ok(all.includes("deploy [project]"), "available skills are listed");
  assert.ok(!all.includes("wip"), "a disabled skill is not in the default roster");

  const search = formatSkillsList(registry, "deploy", 20);
  assert.ok(search.includes("deploy"), "the query matches by description/triggers");
  assert.ok(
    search.includes("wip [disabled"),
    "a query surfaces a matching disabled skill, so its absence is explained",
  );

  const bounded = formatSkillsList(registry, undefined, 1);
  assert.ok(bounded.includes("truncated to 1"), "the limit truncates with a note");
});
