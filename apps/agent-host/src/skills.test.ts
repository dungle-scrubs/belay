import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  buildSkillRoster,
  discoverSkillsIn,
  expandSkill,
  renderSkillsList,
  type Skill,
  type SkillRoot,
} from "./skills";

/**
 * Project-local skill roots (D-087): discovery across an ordered project→global root list, with
 * project-local override, no-tombstone-on-disable, root dedup, missing roots, the `/skills` output,
 * and `skill(name)` expansion from the project root. Driven with temp-dir fixtures - no global state.
 */

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh temp dir holding a project root and a global root. */
function roots(): { project: SkillRoot; global: SkillRoot; base: string } {
  const base = mkdtempSync(join(tmpdir(), "trevor-skills-"));
  temps.push(base);
  return {
    base,
    project: { kind: "project", dir: join(base, "project", ".agents", "skills") },
    global: { kind: "global", dir: join(base, "global", ".agents", "skills") },
  };
}

/** Writes `<root>/<id>/SKILL.md` with the given frontmatter fields + body. */
function writeSkill(
  root: SkillRoot,
  id: string,
  frontmatter: Record<string, string | boolean>,
  body = "do the thing",
): void {
  const dir = join(root.dir, id);
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join("\n");
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n${body}\n`);
}

test("local-only and global-only discovery, each tagged with its source root", () => {
  const r = roots();
  writeSkill(r.project, "alpha", { description: "project alpha" });
  assert.deepEqual(
    discoverSkillsIn([r.project, r.global]).map((s) => [s.id, s.rootKind]),
    [["alpha", "project"]],
  );

  const r2 = roots();
  writeSkill(r2.global, "beta", { description: "global beta" });
  assert.deepEqual(
    discoverSkillsIn([r2.project, r2.global]).map((s) => [s.id, s.rootKind]),
    [["beta", "global"]],
  );
});

test("a missing local or global root is treated as empty (never throws)", () => {
  const r = roots();
  // Only the global root exists.
  writeSkill(r.global, "beta", { description: "global beta" });
  assert.deepEqual(
    discoverSkillsIn([r.project, r.global]).map((s) => s.id),
    ["beta"],
  );
  // Only the project root exists.
  const r2 = roots();
  writeSkill(r2.project, "alpha", { description: "project alpha" });
  assert.deepEqual(
    discoverSkillsIn([r2.project, r2.global]).map((s) => s.id),
    ["alpha"],
  );
  // Neither exists.
  assert.deepEqual(discoverSkillsIn([roots().project, roots().global]), []);
});

test("an enabled project-local skill overrides a global one of the same id", async () => {
  const r = roots();
  writeSkill(r.project, "shared", { description: "the project version" }, "PROJECT BODY");
  writeSkill(r.global, "shared", { description: "the global version" }, "GLOBAL BODY");
  const found = discoverSkillsIn([r.project, r.global]);
  assert.equal(found.length, 1);
  const skill = found[0] as Skill;
  assert.equal(skill.rootKind, "project");
  assert.equal(skill.description, "the project version");
  // skill(name) expands the SELECTED (project) body.
  assert.match(await expandSkill(skill), /PROJECT BODY/);
});

test("a disabled project file leaves no tombstone - the global skill of that id still wins", () => {
  const r = roots();
  writeSkill(r.project, "gamma", { description: "disabled here", disabled: true });
  writeSkill(r.global, "gamma", { description: "global gamma" });
  const found = discoverSkillsIn([r.project, r.global]);
  assert.deepEqual(
    found.map((s) => [s.id, s.rootKind]),
    [["gamma", "global"]],
  );
});

test("duplicate roots (same dir) are not double-counted", () => {
  const r = roots();
  writeSkill(r.project, "alpha", { description: "a" });
  // Same dir passed twice (as project + global) must still yield one selected skill.
  const dup: SkillRoot = { kind: "global", dir: r.project.dir };
  const found = discoverSkillsIn([r.project, dup]);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.rootKind, "project");
});

test("renderSkillsList reports searched roots when empty and source tags when found", () => {
  const r = roots();
  const empty = renderSkillsList([], [r.project, r.global]);
  assert.match(empty, /No skills found\. Searched:/);
  assert.ok(empty.includes(r.project.dir) && empty.includes(r.global.dir));
  assert.match(empty, /\(project\)/);
  assert.match(empty, /\(global\)/);

  writeSkill(r.project, "alpha", { description: "project alpha" });
  writeSkill(r.global, "beta", { description: "global beta" });
  const list = renderSkillsList(discoverSkillsIn([r.project, r.global]), [r.project, r.global]);
  assert.match(list, /alpha \[project\] - project alpha/);
  assert.match(list, /beta \[global\] - global beta/);
});

/** An in-memory Skill (no disk), for the pure roster builder. */
function inMemorySkill(id: string, description: string): Skill {
  return { id, name: id, description, path: `/x/${id}/SKILL.md`, rootKind: "global" };
}

test("buildSkillRoster lists each skill terse and omits the truncation marker when all fit", () => {
  const roster = buildSkillRoster([
    inMemorySkill("alpha", "Do alpha things"),
    inMemorySkill("beta", "Do beta things. Triggers: when beta is needed"),
  ]);
  // Awareness: a relevant skill's id + blurb is present so the model knows it exists (D-075 M2).
  assert.ok(roster.includes("- alpha: Do alpha things"));
  // The blurb stops at the Triggers tail and the full body never appears inline.
  assert.ok(roster.includes("- beta: Do beta things"));
  assert.ok(!roster.includes("when beta is needed"));
  assert.ok(!roster.includes("not shown"), "no truncation marker when nothing is hidden");
});

test("buildSkillRoster caps the roster and marks the surplus with counts + a skills_list pointer", () => {
  const many = Array.from({ length: 5 }, (_, i) => inMemorySkill(`s${i}`, `desc ${i}`));
  const roster = buildSkillRoster(many, 2);
  // The first two (input order) are inlined; the surplus is summarised, not dropped or body-loaded.
  assert.ok(roster.includes("- s0:"));
  assert.ok(roster.includes("- s1:"));
  assert.ok(!roster.includes("- s2:"), "surplus skill bodies are not inlined");
  // Explicit continuation metadata: how many are hidden, the total, and how to reach them.
  assert.ok(roster.includes("3 more skills not shown"));
  assert.ok(roster.includes("(5 total)"));
  assert.ok(
    roster.includes("skills_list(query)"),
    "points to search, not a speculative all-body load",
  );
});

test("a project-local skill body does NOT auto-run shell interpolation while the gate is off", async () => {
  const r = roots();
  // SKILL_SHELL_INTERPOLATION is off by default (TREVOR_SKILL_SHELL unset in the test env), so the
  // `!` line must survive verbatim rather than executing.
  writeSkill(
    r.project,
    "danger",
    { description: "has a shell line" },
    "before\n!echo SHOULD_NOT_RUN\nafter",
  );
  const skill = discoverSkillsIn([r.project, r.global])[0] as Skill;
  const body = await expandSkill(skill);
  assert.match(body, /!echo SHOULD_NOT_RUN/);
});
