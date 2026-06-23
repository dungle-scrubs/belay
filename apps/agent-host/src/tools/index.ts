import { buildProcessTool } from "../processes";
import { buildSkillTool, discoverSkills } from "../skills";
import { bashTool } from "./bash";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import type { Tool } from "./types";
import { writeTool } from "./write";

const FILE_TOOLS: readonly Tool[] = [
  readTool,
  bashTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  buildProcessTool(),
];

// The skill tool is added only when the library is non-empty, so an empty skills
// dir advertises nothing. Its description carries the skill inventory (level-1
// progressive disclosure); skill(name) loads one body on demand (level 2).
const discoveredSkills = discoverSkills();
const TOOLS: readonly Tool[] = discoveredSkills.length
  ? [...FILE_TOOLS, buildSkillTool(discoveredSkills)]
  : FILE_TOOLS;

/** Tool definitions advertised to the model. */
export const TOOL_DEFS = TOOLS.map(({ name, description, parameters }) => ({
  name,
  description,
  parameters,
}));

/** Executes a tool by name with a raw JSON argument string. */
export async function executeTool(name: string, argumentsJson: string): Promise<string> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return `error: unknown tool "${name}"`;
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
  } catch {
    return "error: tool arguments were not valid JSON";
  }
  return tool.execute(args);
}
