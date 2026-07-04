import { it } from "@effect/vitest";
import { Effect, Exit, Fiber, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { type LeafDeps, type LeafResult, runLeaf, type TurnOutcome } from "./leaf";

const answered = (text: string, output = 10): TurnOutcome => ({
  text,
  usage: { input: 100, output },
  endReason: "answered",
});
const cutoff = (text: string, output = 10): TurnOutcome => ({
  text,
  usage: { input: 100, output },
  endReason: "cutoff",
});
const errored = (cause: string): TurnOutcome => ({
  text: "",
  usage: { input: 0, output: 0 },
  endReason: "error",
  cause,
});
const cancelled = (): TurnOutcome => ({
  text: "",
  usage: { input: 0, output: 0 },
  endReason: "cancelled",
});

/** A deps whose runTurn replays a scripted outcome per turn index (clamped to the last). */
function scripted(outcomes: readonly TurnOutcome[], repair?: TurnOutcome): LeafDeps {
  return {
    runTurn: (index: number) =>
      Effect.sync(() => outcomes[Math.min(index, outcomes.length - 1)] as TurnOutcome),
    ...(repair ? { repair: () => Effect.succeed(repair) } : {}),
  };
}

const run = <A>(effect: Effect.Effect<LeafResult<A>>): Promise<LeafResult<A>> =>
  Effect.runPromise(effect);

describe("runLeaf - single turn", () => {
  test("an answered turn returns a success with the text and usage", async () => {
    const result = await run(runLeaf({ childSessionId: "c1" }, scripted([answered("done", 42)])));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("done");
      expect(result.childSessionId).toBe("c1");
      expect(result.usage.output).toBe(42);
    }
  });

  test("a failed child turn maps to a typed child-turn-failed with the structured cause", async () => {
    const result = await run(
      runLeaf({ childSessionId: "c1" }, scripted([errored("provider 500")])),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("child-turn-failed");
      expect(result.cause).toContain("provider 500");
      expect(result.childSessionId).toBe("c1");
    }
  });

  test("a cancelled child turn maps to a typed cancelled failure", async () => {
    const result = await run(runLeaf({ childSessionId: "c1" }, scripted([cancelled()])));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("cancelled");
    }
  });

  test("a single-turn leaf does not continue a cut-off turn (maxTurns defaults to 1)", async () => {
    let calls = 0;
    const deps: LeafDeps = {
      runTurn: (index) =>
        Effect.sync(() => {
          calls++;
          return cutoff(`turn ${index}`);
        }),
    };
    const result = await run(runLeaf({ childSessionId: "c1" }, deps));
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("turn 0");
    }
  });
});

describe("runLeaf - multi-turn (D-017)", () => {
  test("continues cut-off turns until an answered turn, one leaf across many turns", async () => {
    let calls = 0;
    const deps: LeafDeps = {
      runTurn: (index) =>
        Effect.sync(() => {
          calls++;
          return index < 2 ? cutoff(`partial ${index}`) : answered("finished");
        }),
    };
    const result = await run(runLeaf({ childSessionId: "c1", maxTurns: 5 }, deps));
    expect(calls).toBe(3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("finished");
    }
  });

  test("stops at maxTurns with best-effort text when still cut off", async () => {
    let calls = 0;
    const deps: LeafDeps = {
      runTurn: (index) =>
        Effect.sync(() => {
          calls++;
          return cutoff(`partial ${index}`);
        }),
    };
    const result = await run(runLeaf({ childSessionId: "c1", maxTurns: 3 }, deps));
    expect(calls).toBe(3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("partial 2");
    }
  });

  test("a per-leaf token cap tripped mid-task returns budget-exhausted carrying the partial text", async () => {
    const deps = scripted([cutoff("partial", 60), cutoff("more", 60), answered("done", 60)]);
    const result = await run(
      runLeaf({ childSessionId: "c1", maxTurns: 5, tokenBudget: 100 }, deps),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("budget-exhausted");
      // The cap trips after turn 1 (cumulative 120 >= 100); the carried partial is the latest text.
      expect(result.detail).toBe("more");
      expect(result.cause).toContain("token cap");
    }
  });

  test("aggregates output usage across turns", async () => {
    const deps = scripted([cutoff("a", 30), cutoff("b", 30), answered("c", 30)]);
    const result = await run(runLeaf({ childSessionId: "c1", maxTurns: 5 }, deps));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage.output).toBe(90);
    }
  });
});

describe("runLeaf - schema-forced result", () => {
  const schema = Schema.Struct({ n: Schema.Number });

  test("validates the final text against the schema and returns the object", async () => {
    const result = await run(
      runLeaf({ childSessionId: "c1", schema }, scripted([answered('{"n":7}')])),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ n: 7 });
    }
  });

  test("runs one repair turn on a schema mismatch, then returns the repaired object", async () => {
    const deps = scripted([answered("not json")], answered('{"n":9}'));
    const result = await run(runLeaf({ childSessionId: "c1", schema }, deps));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ n: 9 });
    }
  });

  test("a still-invalid repair returns a typed schema-invalid with the partial text as detail", async () => {
    const deps = scripted([answered("not json")], answered('{"n":"still-bad"}'));
    const result = await run(runLeaf({ childSessionId: "c1", schema }, deps));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("schema-invalid");
      expect(result.detail).toBe('{"n":"still-bad"}');
    }
  });

  test("no repair dep + invalid output is schema-invalid immediately", async () => {
    const result = await run(
      runLeaf({ childSessionId: "c1", schema }, scripted([answered("nope")])),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("schema-invalid");
    }
  });
});

describe("runLeaf - cancellation", () => {
  it.effect("fiber interruption halts an in-flight leaf", () =>
    Effect.gen(function* () {
      let started = false;
      const deps: LeafDeps = {
        runTurn: () =>
          Effect.suspend(() => {
            started = true;
            return Effect.never;
          }),
      };
      const fiber = yield* Effect.fork(runLeaf({ childSessionId: "c1" }, deps));
      yield* Effect.yieldNow();
      const exit = yield* Fiber.interrupt(fiber);
      expect(started).toBe(true);
      expect(Exit.isInterrupted(exit)).toBe(true);
    }),
  );
});
