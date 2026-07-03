import assert from "node:assert/strict";
import { Effect, Fiber } from "effect";
import { test } from "vitest";
import { interpretFiberExit, interruptFiber } from "./fiber-exit";

test("interpretFiberExit returns the success value", async () => {
  const exit = await Effect.runPromiseExit(Effect.succeed("done"));

  assert.deepEqual(interpretFiberExit(exit), { tag: "ok", value: "done" });
});

test("interpretFiberExit treats interruption as cancellation", async () => {
  const fiber = Effect.runFork(Effect.never);

  interruptFiber(fiber);
  const exit = await Effect.runPromise(Fiber.await(fiber));

  assert.deepEqual(interpretFiberExit(exit), { tag: "cancelled" });
});

test("interpretFiberExit pretty-prints non-interrupt failures", async () => {
  const exit = await Effect.runPromiseExit(Effect.fail(new Error("boom")));
  const result = interpretFiberExit(exit);

  assert.equal(result.tag, "failed");
  assert.match(result.tag === "failed" ? result.cause : "", /boom/);
});
