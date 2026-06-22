import { exec } from "node:child_process";
import { promisify } from "node:util";
import { classifyAlwaysPreventedBashCommand } from "./bash-safety";
import { cap } from "./shared";
import type { Tool } from "./types";

const execAsync = promisify(exec);

/** Runs a shell command in the host's working directory (timeout + output cap). */
export const bashTool: Tool = {
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
