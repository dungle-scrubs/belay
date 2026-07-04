import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { buildWorkflowTool } from "./invoke";
import type { WorkflowSpec } from "./spec";

const validSpec = {
  meta: { name: "review", description: "review" },
  phases: [{ title: "Review", mode: "parallel", agents: [{ id: "a", prompt: "find bugs" }] }],
};

function toolWith() {
  const started: { spec: WorkflowSpec; args: unknown }[] = [];
  const tool = buildWorkflowTool({
    startRun: (spec, args) =>
      Effect.sync(() => {
        started.push({ spec, args });
        return { runId: "run-42" };
      }),
  });
  return { tool, started };
}

describe("Workflow tool", () => {
  test("validates the spec, starts a detached run, and acknowledges with the run id", async () => {
    const { tool, started } = toolWith();
    const ack = await Effect.runPromise(tool.execute({ spec: validSpec, args: { plans: ["21"] } }));
    expect(ack).toContain("run-42");
    expect(ack).toContain("review");
    expect(started).toHaveLength(1);
    expect(started[0]?.args).toEqual({ plans: ["21"] });
  });

  test("a bad spec is a typed input error and starts no run", async () => {
    const { tool, started } = toolWith();
    const exit = await Effect.runPromiseExit(tool.execute({ spec: { phases: [] } }));
    expect(exit._tag).toBe("Failure");
    expect(started).toHaveLength(0);
  });

  test("a nondeterministic spec (clock reference) is rejected before any run", async () => {
    const { tool, started } = toolWith();
    const nonDeterministic = {
      meta: { name: "x", description: "y" },
      phases: [
        { title: "P", mode: "sequential", agents: [{ id: "a", prompt: "now is Date.now()" }] },
      ],
    };
    const exit = await Effect.runPromiseExit(tool.execute({ spec: nonDeterministic }));
    expect(exit._tag).toBe("Failure");
    expect(started).toHaveLength(0);
  });
});
