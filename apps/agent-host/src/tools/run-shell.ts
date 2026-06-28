import { exec } from "node:child_process";
import { promisify } from "node:util";
import { classifyAlwaysPreventedBashCommand } from "./bash-safety";
import { cap } from "./shared";

const execAsync = promisify(exec);

export interface CommandResult {
  readonly output: string;
  readonly ok: boolean;
}

/**
 * Runs a shell command in the host's working directory under the always-prevented
 * safety floor, a timeout, and an output cap. Shared by the bash tool, the /shell
 * command, and skill shell-interpolation so all three honor the same guardrails.
 * Never rejects - refusals, non-zero exits, and timeouts return `ok: false`.
 */
export async function runCommand(command: string): Promise<CommandResult> {
  const blocked = classifyAlwaysPreventedBashCommand(command, { workspaceRoot: process.cwd() });
  if (blocked) {
    return { output: `refused: ${blocked}`, ok: false };
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
    return { output: cap(output || "(no output)"), ok: true };
  } catch (error) {
    const fail = error as { message?: string; stdout?: string; stderr?: string };
    return {
      output: cap(
        `error: ${fail.message ?? "command failed"}\n${fail.stdout ?? ""}\n${fail.stderr ?? ""}`.trim(),
      ),
      ok: false,
    };
  }
}
