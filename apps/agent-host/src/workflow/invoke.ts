/**
 * The invocation surfaces (plan 21 M7): the model-facing `Workflow` tool that accepts a declarative
 * DSL spec, validates it (M1), and starts it as a DETACHED durable run (M7 lifecycle) - the model
 * gets only an acknowledgement now; the result arrives later as a run-completion notification. A
 * named/saved workflow runs the same way through `runWorkflow` (engine.ts). The `startRun` seam is
 * injected so the host composes the real engine + detached-lifecycle deps.
 *
 * Responsible for: the `Workflow` tool contract (validate a spec, start a detached run, acknowledge).
 * Not for: running the spec (interpreter.ts + engine.ts) or the detached lifecycle (lifecycle.ts).
 */
import { ToolInputError } from "@host/tools/errors";
import type { Tool } from "@host/tools/types";
import { Effect, Either, Schema } from "effect";
import { decodeWorkflowSpec, type WorkflowSpec } from "./spec";

export interface WorkflowToolDeps {
  /** Start a detached durable run for a validated spec + args; resolves with the run id the ack names. */
  readonly startRun: (
    spec: WorkflowSpec,
    args: unknown,
  ) => Effect.Effect<{ readonly runId: string }>;
}

const Params = Schema.Struct({
  spec: Schema.Unknown.annotations({
    description:
      "A workflow spec: { meta:{name,description}, phases:[{title,mode:sequential|parallel|pipeline,agents:[{id,prompt,model?,schema?,isolation?,deps?}]}] }. Data only - no clocks/RNG.",
  }),
  args: Schema.optional(Schema.Unknown).annotations({
    description: "Optional args passed to the run",
  }),
});

/**
 * Build the `Workflow` tool over an injected `startRun`. It decodes+validates the spec (a determinism
 * failure or bad shape is a typed input error the model can fix), then starts the detached run and
 * returns an acknowledgement naming the run - the run streams progress and notifies on completion.
 */
export function buildWorkflowTool(deps: WorkflowToolDeps): Tool<typeof Params.Type> {
  return {
    name: "Workflow",
    description:
      "Run a deterministic multi-agent workflow from a declarative spec (phases of agent leaves, run " +
      "sequential / parallel / pipeline). It runs in the background as a durable, resumable run and " +
      "notifies you on completion - you keep working meanwhile.",
    params: Params,
    execute: (args) => {
      const decoded = decodeWorkflowSpec(args.spec);
      if (Either.isLeft(decoded)) {
        return Effect.fail(new ToolInputError({ tool: "Workflow", detail: decoded.left.detail }));
      }
      const spec = decoded.right;
      return deps
        .startRun(spec, args.args)
        .pipe(
          Effect.map(
            (handle) =>
              `Started workflow "${spec.meta.name}" as durable run ${handle.runId}. Continue with ` +
              "other work; its result will arrive later as a run-completion notification, not as this tool's result.",
          ),
        );
    },
  };
}
