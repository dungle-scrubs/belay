import { Either, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { createWorkflowRegistry, type WorkflowDefinition } from "./registry";

const fleet: WorkflowDefinition = {
  source: "builtin",
  name: "worktree-fleet",
  description: "implement N plans in parallel worktrees",
  args: Schema.Struct({ plans: Schema.Array(Schema.String) }),
};

const saved: WorkflowDefinition = {
  source: "spec",
  name: "review",
  description: "review changed files",
  spec: { meta: { name: "review", description: "review changed files" }, phases: [] },
};

describe("createWorkflowRegistry", () => {
  const registry = createWorkflowRegistry([fleet, saved]);

  test("lists all definitions and gets one by name", () => {
    expect(registry.list()).toHaveLength(2);
    expect(registry.get("worktree-fleet")?.source).toBe("builtin");
    expect(registry.get("review")?.source).toBe("spec");
    expect(registry.get("nope")).toBeUndefined();
  });

  test("resolve returns WorkflowNotFound for an unknown name", () => {
    const result = registry.resolve("nope", {});
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("WorkflowNotFound");
    }
  });

  test("resolve rejects args that fail the definition's args schema", () => {
    const result = registry.resolve("worktree-fleet", { plans: "not-an-array" });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("WorkflowArgsInvalid");
    }
  });

  test("resolve accepts args that satisfy the schema and returns the decoded value", () => {
    const result = registry.resolve("worktree-fleet", { plans: ["21", "46"] });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.definition.name).toBe("worktree-fleet");
      expect(result.right.args).toEqual({ plans: ["21", "46"] });
    }
  });

  test("resolve passes args through when the definition declares no args schema", () => {
    const result = registry.resolve("review", { anything: true });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.definition.name).toBe("review");
    }
  });
});
