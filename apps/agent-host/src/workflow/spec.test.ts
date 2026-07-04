import { Either } from "effect";
import { describe, expect, test } from "vitest";
import { decodeWorkflowSpec, findNondeterminism, type WorkflowSpec } from "./spec";

const validSpec = {
  meta: { name: "review", description: "review changed files" },
  phases: [
    {
      title: "Review",
      mode: "parallel",
      agents: [
        {
          id: "bugs",
          prompt: "find bugs",
          model: { sourceId: "anthropic", modelId: "claude-opus-4-8", reasoning: null },
        },
        { id: "perf", prompt: "find perf issues", deps: ["bugs"] },
      ],
    },
    {
      title: "Verify",
      mode: "pipeline",
      agents: [
        {
          id: "verify",
          prompt: "verify each finding",
          isolation: "worktree",
          schema: { type: "object" },
        },
      ],
    },
  ],
};

describe("decodeWorkflowSpec", () => {
  test("accepts a valid spec (phases; agents with a ModelRef, isolation, schema, deps; all modes)", () => {
    const result = decodeWorkflowSpec(validSpec);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.meta.name).toBe("review");
      expect(result.right.phases.map((phase) => phase.mode)).toEqual(["parallel", "pipeline"]);
    }
  });

  test("rejects a missing meta header", () => {
    const result = decodeWorkflowSpec({ phases: [] });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("WorkflowSpecInvalid");
    }
  });

  test("rejects an unknown phase mode", () => {
    const result = decodeWorkflowSpec({
      meta: { name: "x", description: "y" },
      phases: [{ title: "P", mode: "fanout", agents: [] }],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  test("rejects a non-string model.sourceId (ModelRef shape)", () => {
    const result = decodeWorkflowSpec({
      meta: { name: "x", description: "y" },
      phases: [
        {
          title: "P",
          mode: "sequential",
          agents: [{ id: "a", prompt: "p", model: { sourceId: 1, modelId: "m", reasoning: null } }],
        },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  test("rejects a clock reference in a prompt (static determinism gate)", () => {
    const result = decodeWorkflowSpec({
      meta: { name: "x", description: "y" },
      phases: [
        { title: "P", mode: "sequential", agents: [{ id: "a", prompt: "now is Date.now()" }] },
      ],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.detail).toContain("Date.now");
    }
  });

  test("rejects an RNG reference in the meta header (non-literal header)", () => {
    const result = decodeWorkflowSpec({
      meta: { name: "run-Math.random()", description: "y" },
      phases: [],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.detail).toContain("Math.random");
    }
  });
});

describe("findNondeterminism", () => {
  test("reports the path for a `new Date` leaf deep in a prompt", () => {
    const spec = {
      meta: { name: "n", description: "d" },
      phases: [{ title: "P", mode: "sequential", agents: [{ id: "a", prompt: "at new Date()" }] }],
    } as unknown as WorkflowSpec;
    const hits = findNondeterminism(spec);
    expect(hits.some((hit) => hit.includes("new Date"))).toBe(true);
    expect(hits.some((hit) => hit.includes("phases[0].agents[0].prompt"))).toBe(true);
  });

  test("returns empty for a clean spec", () => {
    const spec = { meta: { name: "n", description: "d" }, phases: [] } as unknown as WorkflowSpec;
    expect(findNondeterminism(spec)).toEqual([]);
  });
});
