import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatter, sortedVisibleEntries, strList, trimStr } from "./manifest-discovery";
import { discoverSkills } from "./skills";
import { READ_ONLY_TOOLS, TOOL_DEFS } from "./tools";

/**
 * Subagent discovery + allow-list resolution (D-045…D-049), modeled on skills.ts.
 *
 * A subagent is a delegated agent that runs in its OWN isolated context and returns a distilled
 * result. A definition is `{ description, tools, skills?, body }`: `description` is what the model
 * picks an agent by; `tools` and `skills` are SEPARATE allow-lists (tools gate executable
 * capabilities, skills gate which skill names/descriptions are prompt-visible and loadable); `body`
 * is the system prompt. `tools: ['*']` means every tool; a `readOnly` flavor is clamped to the
 * read-only tools regardless. No per-agent model in this round - all inherit the session model.
 *
 * Two built-ins ship: `general-purpose` (all tools) and `explorer` (read-only). User-defined agents
 * are discovered from `<TREVOR_AGENTS_DIR>/<id>/AGENT.md` (frontmatter + body) like skills, and
 * override a built-in of the same id. The discovered roster is announced in host.online so the model
 * can choose one by description.
 */

/** Configurable agents root; one agent per `<dir>/<id>/AGENT.md`. */
export const AGENTS_DIR = resolve(
  process.env.TREVOR_AGENTS_DIR ?? join(homedir(), ".agents", "agents"),
);

/** A delegated subagent's contract. */
export interface AgentDefinition {
  readonly id: string;
  readonly description: string;
  /** Tool allow-list: executable capabilities. `['*']` = every tool. */
  readonly tools: readonly string[];
  /** Skill allow-list: prompt-visible + loadable skill ids. `['*']` or omitted = every skill. */
  readonly skills?: readonly string[];
  /** The agent's system prompt body. */
  readonly body: string;
  /** Read-only flavor: the resolved tool set is clamped to the read-only tools (no write/edit/
   *  multi_edit/bash or any other mutating tool), whatever `tools` lists. */
  readonly readOnly?: boolean;
  /** Where this definition came from: a built-in flavor, a discovered user file, or a runtime
   *  model-minted ("ephemeral") definition that lives only for the duration of one delegation. */
  readonly source: "built-in" | "user" | "ephemeral";
}

/** What host.online announces per agent so the model can pick one by description (no body). */
export interface AgentDescriptor {
  readonly id: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
}

const GENERAL_PURPOSE_BODY = [
  "You are a general-purpose subagent delegated a focused task by a parent agent.",
  "You run in your own isolated context: you see ONLY the task you were given, not the parent's",
  "conversation. Work the task end to end with the tools available to you, then return a single,",
  "distilled final message - the answer or result the parent needs, not a transcript of your steps.",
  "Be concrete and complete; the parent cannot see your intermediate work, only your final message.",
].join("\n");

const EXPLORER_BODY = [
  "You are a read-only exploration subagent delegated a focused investigation by a parent agent.",
  "You run in your own isolated context and have READ-ONLY tools only: you can read files, list and",
  "search the workspace, and search the web, but you cannot modify anything. Investigate the task",
  "and return a single, distilled final message - the findings the parent needs (paths, snippets,",
  "answers), not a transcript of your steps. The parent sees only your final message.",
].join("\n");

/** The built-in agent flavors (D-045). */
const BUILT_INS: readonly AgentDefinition[] = [
  {
    id: "general-purpose",
    description:
      "A general-purpose agent with the full tool set for an end-to-end subtask: research, multi-step edits, or any delegated task whose steps you don't need to see.",
    tools: ["*"],
    skills: ["*"],
    body: GENERAL_PURPOSE_BODY,
    source: "built-in",
  },
  {
    id: "explorer",
    description:
      "A read-only agent for fanning out investigation: read, search, and report. Cannot modify the workspace. Use it to explore code or gather facts without side effects.",
    tools: ["*"],
    skills: ["*"],
    readOnly: true,
    body: EXPLORER_BODY,
    source: "built-in",
  },
];

/** Builds a user AgentDefinition from an AGENT.md, or null if its frontmatter disables/breaks it. */
function toAgent(id: string, text: string): AgentDefinition | null {
  const { data, body } = parseFrontmatter(text);
  if (data.disabled === true) {
    return null;
  }
  const description = trimStr(data.description);
  if (!description) {
    return null; // an agent with no description can't be picked; skip it
  }
  return {
    id,
    description: description.replace(/\s+/g, " ").trim(),
    tools: strList(data.tools) ?? ["*"],
    skills: strList(data.skills),
    body: body.trim(),
    readOnly: data.readOnly === true,
    source: "user",
  };
}

let cache: AgentDefinition[] | null = null;

/** Discovers agents: the built-ins, overlaid by user-defined ones under AGENTS_DIR (same id wins
 *  for the user file). Memoized; a missing dir yields just the built-ins. */
export function discoverAgents(): readonly AgentDefinition[] {
  if (cache) {
    return cache;
  }
  const byId = new Map<string, AgentDefinition>(BUILT_INS.map((a) => [a.id, a]));
  for (const entry of sortedVisibleEntries(AGENTS_DIR)) {
    try {
      const agent = toAgent(entry, readFileSync(join(AGENTS_DIR, entry, "AGENT.md"), "utf8"));
      if (agent) {
        byId.set(agent.id, agent); // a user file overrides a built-in of the same id
      }
    } catch {
      // no readable AGENT.md here - skip it
    }
  }
  cache = [...byId.values()];
  return cache;
}

/** Resets the discovery cache (tests that point AGENTS_DIR at a fixture). */
export function resetAgentsCache(): void {
  cache = null;
}

/** The concrete tool names this agent may execute: `['*']` expands to the whole registry; explicit
 *  names are intersected with it (unknown names dropped); a read-only flavor is clamped to the
 *  read-only tools. The single source of an agent's executable surface. */
export function resolveAgentTools(def: AgentDefinition): readonly string[] {
  const all = TOOL_DEFS.map((t) => t.name);
  let names = def.tools.includes("*") ? all : def.tools.filter((t) => all.includes(t));
  if (def.readOnly) {
    names = names.filter((t) => READ_ONLY_TOOLS.has(t));
  }
  return names;
}

/** The skill ids this agent may see + load: `['*']`/omitted = every discovered skill; explicit
 *  names are intersected with the discovered set. */
export function resolveAgentSkills(def: AgentDefinition): readonly string[] {
  const all = discoverSkills().map((s) => s.id);
  if (!def.skills || def.skills.includes("*")) {
    return all;
  }
  return def.skills.filter((s) => all.includes(s));
}

/** The host.online descriptor for an agent: id + description + resolved allow-lists, no body. */
export function describeAgent(def: AgentDefinition): AgentDescriptor {
  return {
    id: def.id,
    description: def.description,
    tools: resolveAgentTools(def),
    skills: resolveAgentSkills(def),
  };
}
