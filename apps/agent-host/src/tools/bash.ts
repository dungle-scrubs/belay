import { runShell } from "./run-shell";
import type { Tool } from "./types";

/** Runs a shell command in the host's working directory (safety floor, timeout, cap). */
export const bashTool: Tool = {
  name: "bash",
  description: "Run a shell command in the host working directory; returns stdout and stderr.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "Shell command to run" } },
    required: ["command"],
  },
  execute: (args) => runShell(String(args.command ?? "")),
};
