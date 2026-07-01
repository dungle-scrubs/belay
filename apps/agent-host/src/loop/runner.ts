import type { LoopSpec } from "@trevor/session";
import { runCommand } from "../tools/run-shell";

/**
 * The `/loop` iteration RUNNER (plan 17, M5): runs ONE iteration of a loop's body through the path its
 * runner type selects (D-009) - a current-session prompt, a background-agent prompt, or a shell process -
 * and returns a bounded, redacted {@link IterationOutcome}. It carries NO scheduling or lifecycle (M6/domain
 * drive those); it just executes one body and reports whether it succeeded.
 *
 * Each path is an injected SEAM so the runtime unit-tests without a live turn machine or a real subagent;
 * the process seam defaults to the real {@link runCommand} (the shared safety floor + timeout + output cap),
 * and main.ts wires the prompt/background seams to the ordinary turn/session and background-agent paths.
 */

/** The outcome of running one iteration: success plus a short, REDACTED summary (never raw process output). */
export interface IterationOutcome {
  readonly ok: boolean;
  readonly summary: string;
  /** Set only when `ok` is false. */
  readonly error?: string;
}

/** The per-runner-type execution seams. Injected; main.ts binds them to the real host paths. */
export interface LoopRunnerSeams {
  /** Runs a shell command for a `process` loop (through the command/process safety boundary). */
  readonly runProcess: (
    command: string,
  ) => Promise<{ readonly ok: boolean; readonly output: string }>;
  /** Injects a prompt into the CURRENT session's turn and resolves when it completes. */
  readonly runPrompt: (
    prompt: string,
  ) => Promise<{ readonly ok: boolean; readonly summary: string }>;
  /** Spawns a BACKGROUND agent for the prompt without blocking the active session, resolving on completion. */
  readonly runBackground: (
    prompt: string,
  ) => Promise<{ readonly ok: boolean; readonly summary: string }>;
}

/** Runs one iteration of a loop's body. */
export interface LoopIterationRunner {
  run(spec: LoopSpec): Promise<IterationOutcome>;
}

const SUMMARY_PREVIEW = 200;

/** Collapse whitespace and cap length so a status/transcript line can never carry a wall of raw output. */
function redact(output: string): string {
  const line = output.replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_PREVIEW ? `${line.slice(0, SUMMARY_PREVIEW)}…` : line;
}

/** The real process seam: the shared {@link runCommand} (safety floor, 30s timeout, 1 MiB output cap). */
export const defaultProcessSeam: LoopRunnerSeams["runProcess"] = (command) => runCommand(command);

/** Builds the iteration runner that dispatches a loop body to the seam its runner type selects. */
export function createLoopIterationRunner(seams: LoopRunnerSeams): LoopIterationRunner {
  return {
    async run(spec: LoopSpec): Promise<IterationOutcome> {
      switch (spec.runner) {
        case "process": {
          const result = await seams.runProcess(spec.action);
          const summary = redact(result.output);
          return result.ok ? { ok: true, summary } : { ok: false, summary, error: summary };
        }
        case "current_session_prompt": {
          const result = await seams.runPrompt(spec.action);
          return result.ok
            ? { ok: true, summary: result.summary }
            : { ok: false, summary: result.summary, error: result.summary };
        }
        case "background_agent": {
          const result = await seams.runBackground(spec.action);
          return result.ok
            ? { ok: true, summary: result.summary }
            : { ok: false, summary: result.summary, error: result.summary };
        }
      }
    },
  };
}
