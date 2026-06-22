import { bashTool } from "./bash";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import type { Tool } from "./types";
import { writeTool } from "./write";

const TOOLS: readonly Tool[] = [readTool, bashTool, writeTool, editTool, globTool, grepTool];

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
