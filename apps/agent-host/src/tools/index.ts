import { Effect } from "effect";
import { log, warn } from "../log";
import { buildProcessTool } from "../processes";
import { buildSkillTool, discoverSkills } from "../skills";
import { buildTaskTools } from "../tasks";
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
  ...buildTaskTools(),
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

/**
 * Executes a tool by name with a raw JSON argument string, as an Effect that never
 * fails: a tool's typed ToolError is rendered to an `error:` result the model can read -
 * one bad tool call must not collapse the whole turn - and attributed to that tool in
 * the host log. `runId` (the turn's correlation id) only tags the boundary log.
 */
export function executeTool(
  name: string,
  argumentsJson: string,
  runId?: string,
): Effect.Effect<string> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return Effect.succeed(`error: unknown tool "${name}"`);
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
  } catch {
    return Effect.succeed("error: tool arguments were not valid JSON");
  }
  const startedAt = Date.now();
  return tool.execute(args).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        log("tool", "executed", { run: runId, name, ms: Date.now() - startedAt, ok: true }),
      ),
    ),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        warn("tool", "failed", {
          run: runId,
          name,
          ms: Date.now() - startedAt,
          error: error.message,
        });
        return `error: ${name} failed - ${error.message}`;
      }),
    ),
  );
}
