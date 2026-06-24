import { exec } from "node:child_process";
import { promisify } from "node:util";
import { classifyAlwaysPreventedBashCommand } from "./bash-safety";
import { cap } from "./shared";

const execAsync = promisify(exec);

/**
 * The outcome of running a shell command under the shared floor. `ok` carries the
 * command's (capped) output; `refused` carries the safety-floor reason; `failed`
 * carries the (capped) failure text (message + any stdout/stderr). Each caller renders
 * at its own boundary: the bash tool maps `refused`/`failed` into a typed ToolError,
 * while `/shell` and skill interpolation render the text inline (see `renderShell`).
 */
export type ShellResult =
  | { readonly kind: "ok"; readonly output: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly output: string };

/**
 * Runs a shell command in the host's working directory under the always-prevented
 * safety floor, a timeout, and an output cap. Shared by the bash tool, the /shell
 * command, and skill shell-interpolation so all three honor the same guardrails.
 * Never rejects - failures are returned as a `failed` result.
 */
export async function runShell(command: string): Promise<ShellResult> {
  const blocked = classifyAlwaysPreventedBashCommand(command, { workspaceRoot: process.cwd() });
  if (blocked) {
    return { kind: "refused", reason: blocked };
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
    return { kind: "ok", output: cap(output || "(no output)") };
  } catch (error) {
    const fail = error as { message?: string; stdout?: string; stderr?: string };
    return {
      kind: "failed",
      output: cap(
        `error: ${fail.message ?? "command failed"}\n${fail.stdout ?? ""}\n${fail.stderr ?? ""}`.trim(),
      ),
    };
  }
}

/**
 * Renders a ShellResult to the single inline string the /shell command and skill
 * interpolation substitute - byte-identical to the strings runShell used to return
 * directly: `refused: <reason>` for a refusal, the (capped) failure text for a
 * failure, and the (capped) output for success.
 */
export function renderShell(result: ShellResult): string {
  switch (result.kind) {
    case "refused":
      return `refused: ${result.reason}`;
    case "failed":
      return result.output;
    case "ok":
      return result.output;
  }
}
