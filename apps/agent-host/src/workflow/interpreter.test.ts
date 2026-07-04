import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { type EngineDeps, runWorkflow } from "./engine";
import { interpretSpec } from "./interpreter";
import type { LeafResult } from "./leaf";
import type { WorkflowSpec } from "./spec";

const ok = (text: string): LeafResult => ({
  ok: true,
  childSessionId: "c",
  text,
  usage: { input: 1, output: 5 },
});

function makeDeps() {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const deps: EngineDeps = {
    runId: "run-1",
    emit: (event) =>
      Effect.sync(() => {
        events.push({ type: event.type, payload: event.payload });
      }),
    leafRunner: (prompt) => Effect.succeed(ok(`ran:${prompt}`)),
  };
  return { deps, events };
}

const spec: WorkflowSpec = {
  meta: { name: "review", description: "review" },
  phases: [
    {
      title: "Review",
      mode: "parallel",
      agents: [
        { id: "bugs", prompt: "find bugs" },
        { id: "perf", prompt: "find perf" },
      ],
    },
    { title: "Summarize", mode: "sequential", agents: [{ id: "sum", prompt: "summarize" }] },
  ],
};

describe("interpretSpec", () => {
  test("runs a spec's phases over the engine and journals a leaf per agent", async () => {
    const { deps, events } = makeDeps();
    const result = await Effect.runPromise(
      runWorkflow("review", (api) => interpretSpec(spec, api), {}, deps),
    );
    expect(result.ok).toBe(true);
    expect(result.leaves).toBe(3); // 2 parallel + 1 sequential
    expect(events.filter((e) => e.type === "workflow.phase").map((e) => e.payload.title)).toEqual([
      "Review",
      "Summarize",
    ]);
    expect(events.filter((e) => e.type === "workflow.agent")).toHaveLength(3);
  });

  test("a pipeline phase threads one item through its agents as stages", async () => {
    const { deps } = makeDeps();
    const pipelineSpec: WorkflowSpec = {
      meta: { name: "p", description: "p" },
      phases: [
        {
          title: "Pipe",
          mode: "pipeline",
          agents: [
            { id: "s1", prompt: "stage1" },
            { id: "s2", prompt: "stage2" },
          ],
        },
      ],
    };
    const result = await Effect.runPromise(
      runWorkflow("p", (api) => interpretSpec(pipelineSpec, api), {}, deps),
    );
    expect(result.ok).toBe(true);
    expect(result.leaves).toBe(2);
  });
});
