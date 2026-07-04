import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { checkDeterminism } from "./determinism";
import type { LeafRunner, WorkflowBody } from "./engine";
import type { LeafResult } from "./leaf";

const ok = (text: string): LeafResult => ({
  ok: true,
  childSessionId: "c",
  text,
  usage: { input: 1, output: 5 },
});
const leafRunner: LeafRunner = (prompt) => Effect.succeed(ok(`ran:${prompt}`));

describe("checkDeterminism (D-021)", () => {
  test("a deterministic built-in (fixed fan-out) passes", async () => {
    const body: WorkflowBody = (api) =>
      api.parallel([() => api.agent("a"), () => api.agent("b")]).pipe(Effect.map(() => undefined));
    const report = await checkDeterminism("good", body, {}, leafRunner);
    expect(report.deterministic).toBe(true);
    expect(report.passes[0]).toEqual(report.passes[1]);
  });

  test("a built-in that branches on the wall clock is caught (divergent ordinals)", async () => {
    // Reads Date.now() (frozen to a different value per pass) to decide how many leaves to spawn.
    const body: WorkflowBody = (api) =>
      Effect.gen(function* () {
        const count = Date.now() > 1_500_000 ? 3 : 1;
        for (let i = 0; i < count; i++) {
          yield* api.agent(`leaf-${i}`);
        }
        return count;
      });
    const report = await checkDeterminism("clocky", body, {}, leafRunner);
    expect(report.deterministic).toBe(false);
    expect(report.divergence).toContain("diverged");
  });

  test("a built-in that reads Math.random() is caught (forbidden RNG)", async () => {
    const body: WorkflowBody = (api) =>
      Effect.gen(function* () {
        const pick = Math.random() > 0.5 ? "hi" : "lo";
        yield* api.agent(pick);
        return pick;
      });
    const report = await checkDeterminism("randy", body, {}, leafRunner);
    expect(report.deterministic).toBe(false);
    expect(report.divergence).toContain("diverged");
  });

  test("Date.now / Math.random are restored after the harness runs", async () => {
    const before = Date.now();
    await checkDeterminism(
      "noop",
      (api) => api.agent("x").pipe(Effect.map(() => undefined)),
      {},
      leafRunner,
    );
    expect(Date.now()).toBeGreaterThanOrEqual(before);
    expect(typeof Math.random()).toBe("number");
  });
});
