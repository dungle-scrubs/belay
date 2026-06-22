import { exec } from "node:child_process";
import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { classifyAlwaysPreventedBashCommand } from "./bash-safety";
import { confine, WORKSPACE_ROOT } from "./workspace";

const execAsync = promisify(exec);
const MAX_OUTPUT = 8000;
const MAX_GLOB = 500;
const MAX_GREP_FILES = 2000;
const MAX_GREP_MATCHES = 100;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|\.next)\//u;

function cap(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text;
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    const blocked = classifyAlwaysPreventedBashCommand(command, { workspaceRoot: process.cwd() });
    if (blocked) {
      return `refused: ${blocked}`;
    }
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

/** Writes a UTF-8 file (creating parent dirs), confined to the workspace. */
const writeTool: Tool = {
  name: "write",
  description: "Write a UTF-8 text file, creating parent directories. Confined to the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path within the workspace" },
      content: { type: "string", description: "Full file contents to write" },
    },
    required: ["path", "content"],
  },
  async execute(args) {
    try {
      const target = confine(String(args.path ?? ""));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, String(args.content ?? ""), "utf8");
      return `wrote ${relative(WORKSPACE_ROOT, target) || "."}`;
    } catch (error) {
      return `error: ${msg(error)}`;
    }
  },
};

/** Replaces a unique exact substring in a workspace file (like an apply-patch). */
const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact substring in a workspace file. 'old' must appear exactly once. Confined to the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path within the workspace" },
      old: { type: "string", description: "Exact text to replace (must be unique in the file)" },
      new: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old", "new"],
  },
  async execute(args) {
    const old = String(args.old ?? "");
    if (old === "") {
      return "error: 'old' must be non-empty";
    }
    try {
      const target = confine(String(args.path ?? ""));
      const content = await readFile(target, "utf8");
      const occurrences = content.split(old).length - 1;
      if (occurrences === 0) {
        return "error: 'old' text not found";
      }
      if (occurrences > 1) {
        return `error: 'old' text appears ${occurrences} times (must be unique)`;
      }
      await writeFile(target, content.replace(old, String(args.new ?? "")), "utf8");
      return `edited ${relative(WORKSPACE_ROOT, target)}`;
    } catch (error) {
      return `error: ${msg(error)}`;
    }
  },
};

/** Lists workspace files matching a glob pattern. */
const globTool: Tool = {
  name: "glob",
  description: "List workspace files matching a glob pattern, e.g. 'src/**/*.ts'.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to the workspace" },
    },
    required: ["pattern"],
  },
  async execute(args) {
    const pattern = String(args.pattern ?? "");
    try {
      const matches: string[] = [];
      for await (const entry of glob(pattern, { cwd: WORKSPACE_ROOT })) {
        if (SKIP_DIRS.test(`/${entry}/`)) {
          continue;
        }
        matches.push(entry);
        if (matches.length >= MAX_GLOB) {
          matches.push(`…[capped at ${MAX_GLOB}]`);
          break;
        }
      }
      return cap(matches.length > 0 ? matches.sort().join("\n") : "(no matches)");
    } catch (error) {
      return `error: ${msg(error)}`;
    }
  },
};

/** Searches workspace file contents for a regex, returning path:line matches. */
const grepTool: Tool = {
  name: "grep",
  description:
    "Search workspace file contents for a JS regular expression. Optionally restrict files with 'glob' (default '**/*'). Returns path:line:text matches.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression" },
      glob: { type: "string", description: "Optional file glob to search (default '**/*')" },
    },
    required: ["pattern"],
  },
  async execute(args) {
    let regex: RegExp;
    try {
      regex = new RegExp(String(args.pattern ?? ""));
    } catch {
      return "error: invalid regular expression";
    }
    const fileGlob = String(args.glob ?? "**/*");
    const results: string[] = [];
    let scanned = 0;
    try {
      for await (const entry of glob(fileGlob, { cwd: WORKSPACE_ROOT })) {
        if (SKIP_DIRS.test(`/${entry}/`) || scanned >= MAX_GREP_FILES) {
          continue;
        }
        scanned += 1;
        let content: string;
        try {
          content = await readFile(resolve(WORKSPACE_ROOT, entry), "utf8");
        } catch {
          continue; // directory, binary, or unreadable - skip
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] as string;
          if (regex.test(line)) {
            results.push(`${entry}:${i + 1}:${line.trim().slice(0, 200)}`);
            if (results.length >= MAX_GREP_MATCHES) {
              return cap(`${results.join("\n")}\n…[capped at ${MAX_GREP_MATCHES} matches]`);
            }
          }
        }
      }
    } catch (error) {
      return `error: ${msg(error)}`;
    }
    return cap(results.length > 0 ? results.join("\n") : "(no matches)");
  },
};

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
