import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const MAX_OUTPUT = 8000;

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text;
}

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

/** Reads a UTF-8 text file relative to the host's working directory. */
const readTool: Tool = {
  name: "read",
  description: "Read a UTF-8 text file and return its contents.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Path to the file" } },
    required: ["path"],
  },
  async execute(args) {
    const path = String(args.path ?? "");
    try {
      return cap(await readFile(path, "utf8"));
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

/** Runs a shell command in the host's working directory (timeout + output cap). */
const bashTool: Tool = {
  name: "bash",
  description: "Run a shell command in the host working directory; returns stdout and stderr.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "Shell command to run" } },
    required: ["command"],
  },
  async execute(args) {
    const command = String(args.command ?? "");
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const output = [stdout, stderr]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n");
      return cap(output || "(no output)");
    } catch (error) {
      const fail = error as { message?: string; stdout?: string; stderr?: string };
      return cap(
        `error: ${fail.message ?? "command failed"}\n${fail.stdout ?? ""}\n${fail.stderr ?? ""}`.trim(),
      );
    }
  },
};

const TOOLS: readonly Tool[] = [readTool, bashTool];

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
