import { Schema } from "effect";
import type { ProcessRegistry } from "../process-registry";
import type { PromotionConfig } from "./promote-policy";
import { promotedResultText, runPromotable } from "./promote-runner";
import { simpleTool, toolExecution, toolInput } from "./shared";

const Params = Schema.Struct({
  command: Schema.String.annotations({ description: "Shell command to run" }),
});

/**
 * Runs a shell command in the host's working directory (plan 09). It goes through the promotable runner:
 * the same always-prevented safety floor + output cap as before, but a command still running at the
 * promotion threshold is PROMOTED into a tracked background job (`pN`) - returning a result that names the
 * job and the output so far - instead of timing out. A refusal keeps its `refused:` prefix and becomes a
 * ToolInputError; a non-zero command is a ToolExecutionError; a fast command returns its output.
 */
export function buildBashTool(supervisor: ProcessRegistry, config: PromotionConfig) {
  return simpleTool({
    name: "bash",
    description:
      "Run a shell command in the host working directory; returns stdout and stderr. A long-running command is promoted to a background job (pN) you can poll or kill with the process tool, rather than timing out.",
    params: Params,
    execute: async (args) => {
      const result = await runPromotable(supervisor, args.command, process.cwd(), {
        enabled: config.enabled,
        thresholdMs: config.thresholdMs,
        origin: { source: "bash" },
      });
      if (result.decision === "refuse") {
        return toolInput(result.output);
      }
      if (result.decision === "promote") {
        return promotedResultText(result.jobId ?? "?", result.output);
      }
      if (result.decision === "fail") {
        // The failure text is the captured output; drop a leading `error: ` so the executor's own
        // `error: bash failed - ` prefix is not doubled.
        return toolExecution(result.output.replace(/^error:\s*/u, ""));
      }
      return result.output;
    },
  });
}
