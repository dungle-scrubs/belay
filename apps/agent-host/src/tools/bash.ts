import { Effect, Schema } from "effect";
import { type ToolError, ToolExecutionError, ToolInputError } from "./errors";
import { renderShell, runShell } from "./run-shell";
import type { Tool } from "./types";

const Params = Schema.Struct({
  command: Schema.String.annotations({ description: "Shell command to run" }),
});

/**
 * Runs a shell command in the host's working directory (safety floor, timeout, cap).
 * runShell never rejects - it returns a discriminated ShellResult - so the tool adapts
 * it with Effect.promise and then fails in the typed `E` channel: a safety-floor refusal
 * is a ToolInputError, a non-zero command is a ToolExecutionError, and the executor
 * renders either to one `error: …` line.
 */
export const bashTool: Tool<typeof Params.Type> = {
  name: "bash",
  description: "Run a shell command in the host working directory; returns stdout and stderr.",
  params: Params,
  execute: (args) =>
    Effect.promise(() => runShell(args.command)).pipe(
      Effect.flatMap((result): Effect.Effect<string, ToolError> => {
        if (result.kind === "refused") {
          return Effect.fail(new ToolInputError({ tool: "bash", detail: renderShell(result) }));
        }
        if (result.kind === "failed") {
          // The failure text already opens with `error: `; drop it so the executor's own
          // `error: bash failed - ` prefix isn't doubled.
          const detail = result.output.replace(/^error:\s*/u, "");
          return Effect.fail(new ToolExecutionError({ tool: "bash", detail }));
        }
        return Effect.succeed(result.output);
      }),
    ),
};
