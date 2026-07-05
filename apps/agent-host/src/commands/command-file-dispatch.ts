import { log, warn } from "@host/transport/log";
import { msg } from "@host/transport/messages";
import { expandArgs } from "@trevor/session";
import { expandCommandFile } from "./command-file";
import type { LoadedCommandFile } from "./command-loader";
import type { InterpolationConfig } from "./interpolation";

/**
 * The expand-on-dispatch SUBMIT branch for file-loaded commands (plan 44.5, M4). When a user invokes a
 * `.trevor/commands/*.md` command, its body is NOT rendered as a `command.result` (the immediate-command
 * lane) - it is expanded and SUBMITTED as the turn's prompt, so a custom command drives the model exactly
 * like a typed prompt would.
 *
 * The expansion is two ordered passes (D-007): the TRUSTED, author-controlled body is INTERPOLATED first
 * (`expandCommandFile`, gated + allow-listed), then the user-supplied args are SUBSTITUTED into the
 * result (`expandArgs`). This ordering is load-bearing: a `$N` value that happens to contain `!cmd` is
 * spliced AFTER interpolation, so it lands as inert literal text and can never introduce an interpolation
 * site. The raw args string is threaded through verbatim so `$ARGUMENTS` is exactly what the user typed.
 *
 * Responsible for: the interpolate-then-substitute expansion + publishing the expanded body as a prompt,
 * with a dispatch-boundary log and a fail-soft that surfaces an error result instead of throwing.
 * Not for: tokenization/substitution rules (@trevor/session/command-args), interpolation gating
 * (command-file.ts / interpolation.ts), loading files (command-loader.ts), or the control-prompt shape
 * (agent/control-prompts.ts - `publish` is that seam, injected here).
 */

/** The seams the SUBMIT branch needs from main.ts, injected so the branch is unit-tested without a host. */
export interface CommandFileDispatchDeps {
  /** The interpolation gate/policy (usually disabled), applied to the body BEFORE substitution. */
  readonly interpolationConfig: InterpolationConfig;
  /** Publishes the expanded body as the turn's prompt - the control-prompt seam (a `${host}:control`
   *  user.message, so the turn loop treats it as answerable rather than dropping it as self-echo). */
  publish(text: string): Promise<void>;
  /** Emits a `command.result` - used only on the fail-soft path, so a failed expansion is still visible. */
  emitResult(result: { command: string; text: string; ok: boolean }): Promise<void>;
}

export interface CommandFileDispatch {
  /** Expands `file` against the raw args and submits the result as the turn's prompt (D-007 ordering). */
  submit(file: LoadedCommandFile, rawArgs: string): Promise<void>;
}

/** Builds the file-loaded-command SUBMIT branch over its injected seams; main.ts wires it once. */
export function makeCommandFileDispatch(deps: CommandFileDispatchDeps): CommandFileDispatch {
  return {
    async submit(file, rawArgs) {
      try {
        // D-007: interpolate the trusted body FIRST (gated, usually a no-op), THEN substitute user args.
        const interpolated = await expandCommandFile(file, deps.interpolationConfig);
        const expanded = expandArgs(interpolated.text, rawArgs);
        log("host", "command-file dispatch", {
          command: file.id,
          root: file.rootKind,
          args: rawArgs || undefined,
          referenced: expanded.diagnostics.referenced,
          provided: expanded.diagnostics.providedCount,
          missing: expanded.diagnostics.missing.length || undefined,
          appended: expanded.diagnostics.appendedArguments || undefined,
          interpolated: interpolated.diagnostics.length || undefined,
        });
        await deps.publish(expanded.text);
      } catch (error) {
        // Fail-soft: a broken command file never crashes the dispatch - surface a visible error result.
        warn("host", "command-file dispatch failed", { command: file.id, error: msg(error) });
        await deps.emitResult({
          command: file.id,
          text: `error running ${file.id}: ${msg(error)}`,
          ok: false,
        });
      }
    },
  };
}
