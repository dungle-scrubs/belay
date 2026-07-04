/**
 * The DSL interpreter (plan 21 M7): walk a validated, model-authored `WorkflowSpec` over the engine's
 * `WorkflowApi` - NO code execution. Each phase runs its agent leaves sequentially, in parallel (a
 * barrier), or as a pipeline; the model re-enters only at each `agent()` leaf. This is a
 * `WorkflowBody`, so `runWorkflow` runs it exactly like a built-in.
 *
 * Responsible for: turning a `WorkflowSpec` into an orchestration over the `WorkflowApi`.
 * Not for: the spec schema/validation (spec.ts) or the engine harness (engine.ts).
 */
import { Effect } from "effect";
import type { AgentOpts, WorkflowApi } from "./engine";
import type { WorkflowRunError } from "./errors";
import type { AgentSpec, WorkflowSpec } from "./spec";

function optsFrom(agent: AgentSpec): AgentOpts {
  return {
    ...(agent.schema !== undefined ? { schema: agent.schema } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.isolation !== undefined ? { isolation: agent.isolation } : {}),
  };
}

/**
 * Interpret a spec over the api, returning the flat list of leaf results in phase order. `sequential`
 * runs agents one after another; `parallel` fans them out under the concurrency cap (barrier);
 * `pipeline` threads one implicit item through the agents as stages.
 */
export function interpretSpec(
  spec: WorkflowSpec,
  api: WorkflowApi,
): Effect.Effect<ReadonlyArray<unknown>, WorkflowRunError> {
  return Effect.gen(function* () {
    const results: unknown[] = [];
    for (const phase of spec.phases) {
      yield* api.phase(phase.title);
      if (phase.mode === "sequential") {
        for (const agent of phase.agents) {
          results.push(yield* api.agent(agent.prompt, optsFrom(agent)));
        }
      } else if (phase.mode === "parallel") {
        const out = yield* api.parallel(
          phase.agents.map((agent) => () => api.agent(agent.prompt, optsFrom(agent))),
        );
        results.push(...out);
      } else {
        const out = yield* api.pipeline(
          [null],
          phase.agents.map((agent) => () => api.agent(agent.prompt, optsFrom(agent))),
        );
        results.push(...out);
      }
    }
    return results;
  });
}
