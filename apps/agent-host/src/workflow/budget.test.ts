import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { BudgetGovernor, budgetLayer, makeBudget } from "./budget";
import type { TurnUsage } from "./leaf";

const usage = (output: number): TurnUsage => ({ input: 0, output });

describe("WorkflowBudget - shared pool", () => {
  test("accumulates generated tokens across leaves", async () => {
    const budget = await Effect.runPromise(makeBudget(1000));
    await Effect.runPromise(budget.record(usage(30)));
    await Effect.runPromise(budget.record(usage(45)));
    expect(await Effect.runPromise(budget.spent)).toBe(75);
  });

  test("remaining() is total - spent, and Infinity when unbounded", async () => {
    const bounded = await Effect.runPromise(makeBudget(100));
    await Effect.runPromise(bounded.record(usage(60)));
    expect(await Effect.runPromise(bounded.remaining)).toBe(40);

    const unbounded = await Effect.runPromise(makeBudget(null));
    await Effect.runPromise(unbounded.record(usage(999)));
    expect(await Effect.runPromise(unbounded.remaining)).toBe(Number.POSITIVE_INFINITY);
  });

  test("remaining() never goes negative", async () => {
    const budget = await Effect.runPromise(makeBudget(50));
    await Effect.runPromise(budget.record(usage(80)));
    expect(await Effect.runPromise(budget.remaining)).toBe(0);
  });

  test("admit gates a new spawn once the ceiling is spent (typed budget-exhausted)", async () => {
    const budget = await Effect.runPromise(makeBudget(100));
    // Under the ceiling: admitted.
    await Effect.runPromise(budget.record(usage(90)));
    expect(Exit.isSuccess(await Effect.runPromiseExit(budget.admit))).toBe(true);
    // At the ceiling: gated.
    await Effect.runPromise(budget.record(usage(10)));
    const exit = await Effect.runPromiseExit(budget.admit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error.reason).toBe("budget-exhausted");
    }
  });

  test("an unbounded budget never gates", async () => {
    const budget = await Effect.runPromise(makeBudget(null));
    await Effect.runPromise(budget.record(usage(1_000_000)));
    expect(Exit.isSuccess(await Effect.runPromiseExit(budget.admit))).toBe(true);
  });

  test("a budget trip gates NEW spawns but lets in-flight leaves drain (record still works)", async () => {
    const budget = await Effect.runPromise(makeBudget(100));
    await Effect.runPromise(budget.record(usage(100))); // ceiling reached
    expect(Exit.isFailure(await Effect.runPromiseExit(budget.admit))).toBe(true);
    // A still-running leaf drains its overshoot - recording is never blocked.
    await Effect.runPromise(budget.record(usage(40)));
    expect(await Effect.runPromise(budget.spent)).toBe(140);
  });
});

describe("budgetLayer - service", () => {
  test("provides the governor via Context.Tag", async () => {
    const program = Effect.gen(function* () {
      const budget = yield* BudgetGovernor;
      yield* budget.record(usage(30));
      return yield* budget.remaining;
    });
    const out = await Effect.runPromise(program.pipe(Effect.provide(budgetLayer(100))));
    expect(out).toBe(70);
  });
});
