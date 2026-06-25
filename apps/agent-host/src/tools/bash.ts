import { Effect, Schema } from "effect";
import { type ToolError, ToolExecutionError } from "./errors";
import { renderShell, runShell } from "./run-shell";
import { defineTool } from "./shared";

const Params = Schema.Struct({
  command: Schema.String.annotations({ description: "Shell command to run" }),
});

/**
 * Runs a shell command in the host's working directory (safety floor, timeout, cap).
 * runShell never rejects - it returns a discriminated ShellResult - so the tool's only job is to
 * map that result into the typed `E` channel: a safety-floor refusal is a ToolInputError (via
 * `ops`), a non-zero command is a ToolExecutionError, and the executor renders either to one
 * `error: …` line. Everything else (the floor, timeout, output cap) lives in runShell.
 */
export const bashTool = defineTool({
  name: "bash",
  description: "Run a shell command in the host working directory; returns stdout and stderr.",
  params: Params,
  execute: (args, ops) =>
    Effect.promise(() => runShell(args.command)).pipe(
      Effect.flatMap((result): Effect.Effect<string, ToolError> => {
        if (result.kind === "refused") {
          return ops.reject(renderShell(result));
        }
        if (result.kind === "failed") {
          // The failure text already opens with `error: `; drop it so the executor's own
          // `error: bash failed - ` prefix isn't doubled.
          return Effect.fail(
            new ToolExecutionError({
              tool: "bash",
              detail: result.output.replace(/^error:\s*/u, ""),
            }),
          );
        }
        return Effect.succeed(result.output);
      }),
    ),
});
