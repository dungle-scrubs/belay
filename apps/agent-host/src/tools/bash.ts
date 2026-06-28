import { Schema } from "effect";
import { runCommand } from "./run-shell";
import { simpleTool, toolExecution, toolInput } from "./shared";

const Params = Schema.Struct({
  command: Schema.String.annotations({ description: "Shell command to run" }),
});

/**
 * Runs a shell command in the host's working directory (safety floor, timeout, cap).
 * runCommand never rejects - it returns `{ output, ok }` - so the tool's only job is to map
 * `ok:false` into the typed `E` channel. A safety-floor refusal keeps its `refused:` prefix and
 * becomes a ToolInputError; a non-zero command is a ToolExecutionError. Everything else (the floor,
 * timeout, output cap) lives in runCommand.
 */
export const bashTool = simpleTool({
  name: "bash",
  description: "Run a shell command in the host working directory; returns stdout and stderr.",
  params: Params,
  execute: async (args) => {
    const result = await runCommand(args.command);
    if (!result.ok && result.output.startsWith("refused: ")) {
      return toolInput(result.output);
    }
    if (!result.ok) {
      // The failure text already opens with `error: `; drop it so the executor's own
      // `error: bash failed - ` prefix isn't doubled.
      return toolExecution(result.output.replace(/^error:\s*/u, ""));
    }
    return result.output;
  },
});
