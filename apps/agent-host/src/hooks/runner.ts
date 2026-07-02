import { spawn } from "node:child_process";
import { minimalChildEnv } from "@host/processes/child-env";
import { TRUNCATION_NOTICE } from "@host/tools/shared";
import { msg } from "@host/transport/messages";
import { type HookDefinition, MAX_HOOK_TIMEOUT_MS } from "./config";
import { redactHookText } from "./redact";

/**
 * The hook command runner (plan 25 M3): executes ONE approved hook definition as a child
 * process - `spawn(command, args)` with NO shell ever (D-005), cwd pinned to the workspace
 * root, and the secret-minimal child env shared with the MCP/LSP spawners (D-004; provider
 * keys and TREVOR_* state never reach a hook). The payload is delivered as JSON on stdin and
 * stdin is closed after the write; stdout/stderr are hard-capped with a truncation marker; the
 * per-hook timeout (low default, config-capped) escalates SIGTERM -> grace -> SIGKILL,
 * mirroring lsp/client's reap ladder. The returned execution NEVER rejects - spawn failure,
 * non-zero exit, and timeout are all data in the result (D-007) - so the outcome model is a
 * plain result union rather than a tagged error channel: there is no failure here a caller
 * would branch on as an error. The execution's streams are RAW (capped) because ./decision
 * parses stdout; anything stored or logged goes through {@link redactHookExecution} (D-009).
 *
 * Responsible for: spawning one hook, payload delivery, output caps, the timeout kill ladder,
 * and the redacted execution projection.
 * Not for: decision parsing (./decision), blocking semantics (./results, M4), or the
 * approval gate - callers consult approval.canExecuteHook first.
 */

/** Hard cap per stream (64 KiB of text); a chatty hook cannot balloon stored results. */
export const DEFAULT_HOOK_OUTPUT_CAP_CHARS = 64 * 1024;

/** How long a SIGTERMed hook gets to exit before SIGKILL (the lsp/client grace window). */
export const DEFAULT_HOOK_KILL_GRACE_MS = 2_000;

export interface HookRunnerOptions {
  /** The child's working directory: the workspace root. */
  readonly cwd: string;
  /** The host environment to filter (default `process.env`); injectable for tests. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** SIGTERM -> SIGKILL escalation window (default {@link DEFAULT_HOOK_KILL_GRACE_MS}). */
  readonly killGraceMs?: number;
  /** Per-stream cap (default {@link DEFAULT_HOOK_OUTPUT_CAP_CHARS}); injectable for tests. */
  readonly maxOutputChars?: number;
}

/** One captured stream: capped text plus whether the cap cut it. */
export interface HookStreamCapture {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * What one hook run did, as pure data. `stdout`/`stderr` are raw-but-capped (decision parsing
 * needs the bytes as written); use {@link redactHookExecution} for anything stored or logged.
 */
export interface HookExecution {
  readonly stdout: HookStreamCapture;
  readonly stderr: HookStreamCapture;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Set when the process could not start at all (redacted message); exitCode stays null. */
  readonly spawnError?: string;
}

/** The stored/log/event projection of an execution: streams redacted, shape flattened (D-009). */
export interface HookExecutionLog {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly spawnError?: string;
}

/**
 * Runs one hook to completion. Resolves ALWAYS - every failure mode (spawn error, non-zero
 * exit, timeout, ignored SIGTERM) is data in the {@link HookExecution}, never a rejection.
 */
export function runHook(
  hook: HookDefinition,
  payload: unknown,
  options: HookRunnerOptions,
): Promise<HookExecution> {
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_HOOK_OUTPUT_CAP_CHARS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_HOOK_KILL_GRACE_MS;
  // Defense in depth: config normalization already caps timeoutMs, but the runner re-clamps
  // so a hand-built definition can never stall a turn past the hard ceiling.
  const timeoutMs = Math.min(Math.max(hook.timeoutMs, 1), MAX_HOOK_TIMEOUT_MS);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(hook.command, [...hook.args], {
      cwd: options.cwd,
      env: minimalChildEnv(options.hostEnv ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = createStreamCapture(maxOutputChars);
    const stderr = createStreamCapture(maxOutputChars);
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;
    let hardKill: NodeJS.Timeout | undefined;

    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      hardKill.unref?.();
    }, timeoutMs);
    deadline.unref?.();

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      if (hardKill) {
        clearTimeout(hardKill);
      }
      resolve({
        stdout: stdout.result(),
        stderr: stderr.result(),
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    };

    child.stdout.on("data", stdout.push);
    child.stderr.on("data", stderr.push);
    // A dead child's pipes emit errors (EPIPE on stdin, resets on the read side); without
    // listeners Node rethrows them and crashes the host (the stdio-transport precedent).
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.on("error", (error) => {
      // A failed spawn (ENOENT and friends) may never reach "close"; settle here.
      spawnError = redactHookText(msg(error));
      settle(null, null);
    });
    child.on("close", (code, signal) => settle(code, signal));

    try {
      child.stdin.write(JSON.stringify(payload) ?? "null");
      child.stdin.end();
    } catch {
      // A synchronous stdin throw means the child is already dead; error/close settle it.
    }
  });
}

/** Projects an execution into its stored/log form: streams redacted, truncation flags kept. */
export function redactHookExecution(execution: HookExecution): HookExecutionLog {
  return {
    stdout: redactHookText(execution.stdout.text),
    stderr: redactHookText(execution.stderr.text),
    stdoutTruncated: execution.stdout.truncated,
    stderrTruncated: execution.stderr.truncated,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    durationMs: execution.durationMs,
    ...(execution.spawnError !== undefined ? { spawnError: execution.spawnError } : {}),
  };
}

/** A cap-enforcing stream collector: keeps the first `maxChars`, drops the rest, flags the cut. */
function createStreamCapture(maxChars: number): {
  push: (chunk: Buffer) => void;
  result: () => HookStreamCapture;
} {
  let text = "";
  let truncated = false;
  return {
    push: (chunk: Buffer): void => {
      if (truncated) {
        return;
      }
      text += chunk.toString("utf8");
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
      }
    },
    result: (): HookStreamCapture => ({
      text: truncated ? `${text}${TRUNCATION_NOTICE}` : text,
      truncated,
    }),
  };
}
