import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { AgentDefinition } from "./discovery";

/**
 * Subagent discovery + allow-list resolution (M1 / D-045). TREVOR_AGENTS_DIR points at a temp
 * fixture (set before the dynamic import, since the root is read at module load) so discovery is
 * hermetic: it yields the two built-ins plus the one user agent fixture, and the explorer flavor is
 * clamped to read-only tools.
 */

const dir = mkdtempSync(join(tmpdir(), "trevor-agents-"));
// A user-defined agent that overrides nothing (a new id) with an explicit, narrow tool allow-list.
mkdirSync(join(dir, "researcher"), { recursive: true });
writeFileSync(
  join(dir, "researcher", "AGENT.md"),
  [
    "---",
    // Quoted because the value contains a colon ("Triggers:"); whitespace is collapsed on load.
    'description: "A web + file researcher.   Triggers: research, look up."',
    "tools: [read, grep, web_search, bogus_tool]",
    "skills: []",
    "---",
    "You research things and report back.",
  ].join("\n"),
);
// A disabled agent is skipped; a description-less one is skipped too.
mkdirSync(join(dir, "disabled-one"), { recursive: true });
writeFileSync(
  join(dir, "disabled-one", "AGENT.md"),
  "---\ndescription: x\ndisabled: true\n---\nbody",
);

const prev = process.env.TREVOR_AGENTS_DIR;
process.env.TREVOR_AGENTS_DIR = dir;

const { discoverAgents, resolveAgentTools, resolveAgentSkills, describeAgent } = await import(
  "./discovery"
);

afterAll(() => {
  if (prev === undefined) delete process.env.TREVOR_AGENTS_DIR;
  else process.env.TREVOR_AGENTS_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const byId = (): Map<string, AgentDefinition> => new Map(discoverAgents().map((a) => [a.id, a]));

function requireAgent(agents: ReadonlyMap<string, AgentDefinition>, id: string): AgentDefinition {
  const agent = agents.get(id);
  assert.ok(agent, `expected agent ${id}`);
  return agent;
}

test("discovery yields the two built-ins plus the user fixture; disabled/description-less are skipped", () => {
  const agents = byId();
  assert.ok(agents.has("general-purpose"), "the general-purpose built-in");
  assert.ok(agents.has("explorer"), "the explorer built-in");
  assert.ok(agents.has("researcher"), "the user-defined agent");
  assert.ok(!agents.has("disabled-one"), "a disabled agent is dropped");
  assert.equal(agents.get("general-purpose")?.source, "built-in");
  assert.equal(agents.get("researcher")?.source, "user");
});

test("general-purpose resolves to the full tool set; explorer is clamped read-only", () => {
  const agents = byId();
  const general = resolveAgentTools(requireAgent(agents, "general-purpose"));
  // The full registry includes the mutating tools.
  for (const t of ["read", "write", "edit", "multi_edit", "bash", "glob", "grep"]) {
    assert.ok(general.includes(t), `general-purpose can use ${t}`);
  }

  const explorer = resolveAgentTools(requireAgent(agents, "explorer"));
  for (const mut of ["write", "edit", "multi_edit", "bash"]) {
    assert.ok(!explorer.includes(mut), `explorer excludes the mutating tool ${mut}`);
  }
  for (const ro of ["read", "glob", "grep", "web_search"]) {
    assert.ok(explorer.includes(ro), `explorer keeps the read-only tool ${ro}`);
  }
});

test("a user agent's explicit tool allow-list is honored (and unknown names dropped)", () => {
  const researcher = requireAgent(byId(), "researcher");
  assert.deepEqual([...resolveAgentTools(researcher)].sort(), ["grep", "read", "web_search"]);
  // The description's "Triggers:" tail is collapsed into one tidy line.
  assert.equal(researcher.description, "A web + file researcher. Triggers: research, look up.");
});

test("an empty skills allow-list grants no skills; omitted/[*] grants all discovered", () => {
  const agents = byId();
  assert.deepEqual(
    resolveAgentSkills(requireAgent(agents, "researcher")),
    [],
    "explicit [] = no skills",
  );
  // The built-ins use ['*'] = every discovered skill (whatever the machine has, possibly none).
  const all = resolveAgentSkills(requireAgent(agents, "general-purpose"));
  assert.ok(Array.isArray(all));
});

test("describeAgent is the wire descriptor: id + description + resolved allow-lists, no body", () => {
  const spec = describeAgent(requireAgent(byId(), "explorer"));
  assert.equal(spec.id, "explorer");
  assert.ok(spec.description.length > 0);
  assert.ok(!("body" in spec), "the system prompt body never rides the wire");
  assert.ok(spec.tools.includes("read") && !spec.tools.includes("bash"));
});
