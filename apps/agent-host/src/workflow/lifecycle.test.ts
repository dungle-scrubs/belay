import { Effect, Fiber } from "effect";
import { describe, expect, test } from "vitest";
import type { RunResult } from "./engine";
import { type DetachedRunDeps, startDetachedRun } from "./lifecycle";

const summary: RunResult = { ok: true, leaves: 3, value: undefined };

describe("startDetachedRun (D-018)", () => {
  test("ensures the run session, returns immediately (launcher survives), then notifies on completion", async () => {
    const log: string[] = [];
    let notified: RunResult | undefined;
    const deps: DetachedRunDeps = {
      runId: "run-1",
      ensureRunSession: (runId) =>
        Effect.sync(() => {
          log.push(`ensure:${runId}`);
        }),
      // A run that only completes after a tick, so we can prove startDetachedRun returned first.
      run: Effect.sleep("10 millis").pipe(Effect.as(summary)),
      notifyLauncher: (runId, s) =>
        Effect.sync(() => {
          log.push(`notify:${runId}`);
          notified = s;
        }),
    };

    const handle = await Effect.runPromise(startDetachedRun(deps));
    // Returned before the run completed: only the ensure has happened, not the notify.
    expect(log).toEqual(["ensure:run-1"]);
    expect(notified).toBeUndefined();

    // Await the background fiber: the run completes and the launcher is notified.
    const result = await Effect.runPromise(Fiber.join(handle.fiber));
    expect(result).toEqual(summary);
    expect(log).toEqual(["ensure:run-1", "notify:run-1"]);
    expect(notified).toEqual(summary);
  });

  test("the run fiber is detached (a daemon), so it is not tied to the launcher's scope", async () => {
    let ran = false;
    const deps: DetachedRunDeps = {
      runId: "run-2",
      ensureRunSession: () => Effect.void,
      run: Effect.sync(() => {
        ran = true;
        return summary;
      }),
      notifyLauncher: () => Effect.void,
    };
    const handle = await Effect.runPromise(startDetachedRun(deps));
    await Effect.runPromise(Fiber.join(handle.fiber));
    expect(ran).toBe(true);
  });
});
