import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The shared read-only search-process runner for the binary-backed search tools (ripgrep `grep`,
 * `ast_grep`). It runs a binary with an ARGV ARRAY (never a shell string, so a pattern can't inject
 * shell), confined to a cwd, under a timeout + output cap, and returns the exit code with captured
 * stdout/stderr instead of throwing - so each tool can map exit codes to its own typed result
 * (e.g. ripgrep's exit 1 = "no match", not an error). A spawn failure (binary missing) reports
 * `code: -1` with the OS error in stderr. This is the one place process invocation + its guardrails
 * live for search tools, kept apart from the bash `runShell` floor (search tools are not shell).
 */
export interface SearchProcessOutput {
  /** The process exit code (0 = matches for rg), or -1 when the binary couldn't be spawned. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the process was killed by the timeout. */
  readonly timedOut: boolean;
}

export interface SearchProcessOptions {
  readonly cwd: string;
  /** Wall-clock cap; the process is SIGTERM'd past it (default 15s). */
  readonly timeoutMs?: number;
  /** Max captured stdout bytes (default 4 MiB); a larger output rejects, caught as a failure. */
  readonly maxBuffer?: number;
}

/** The first non-blank line of a process's output (typically stderr), or "" - the shared way both
 *  search tools extract a one-line error summary from a noisy multi-line stderr. */
export const firstLine = (text: string): string => text.split("\n").find((l) => l.trim()) ?? "";

export async function runSearchProcess(
  bin: string,
  args: readonly string[],
  options: SearchProcessOptions,
): Promise<SearchProcessOutput> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr, timedOut: false };
  } catch (cause) {
    // execFile rejects on a non-zero exit (carrying the code + captured stdout/stderr), on the
    // timeout (killed + SIGTERM), and on a spawn failure (code is a string like "ENOENT").
    const err = cause as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
      signal?: string;
    };
    const code = typeof err.code === "number" ? err.code : -1;
    const timedOut = err.killed === true && err.signal === "SIGTERM";
    return {
      code,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      timedOut,
    };
  }
}
