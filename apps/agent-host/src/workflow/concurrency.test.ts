import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import {
  MAX_ITEMS_PER_CALL,
  makeScheduler,
  parallel,
  phase,
  pipeline,
  type WorkflowEmit,
  type WorkflowScheduler,
  log as workflowLog,
} from "./concurrency";
import type { LeafResult } from "./leaf";

const okText = (text: string): LeafResult => ({
  ok: true,
  childSessionId: "c",
  text,
  usage: { input: 0, output: 0 },
});
const okValue = (value: unknown): LeafResult => ({
  ok: true,
  childSessionId: "c",
  text: "",
  value,
  usage: { input: 0, output: 0 },
});
const failed = (cause: string): LeafResult => ({
  ok: false,
  kind: "child-turn-failed",
  childSessionId: "c",
  cause,
});

function collector() {
  const failures: string[] = [];
  const logs: string[] = [];
  const phases: string[] = [];
  const emit: WorkflowEmit = {
    leafFailed: (failure) =>
      Effect.sync(() => {
        failures.push(failure.cause);
      }),
    log: (message) =>
      Effect.sync(() => {
        logs.push(message);
      }),
    phase: (title) =>
      Effect.sync(() => {
        phases.push(title);
      }),
  };
  return { emit, failures, logs, phases };
}

const scheduler = (
  emit: WorkflowEmit,
  options?: Parameters<typeof makeScheduler>[1],
): Promise<WorkflowScheduler> => Effect.runPromise(makeScheduler(emit, options));

describe("parallel - barrier fan-out", () => {
  test("returns values in order, unwrapping schema value or text", async () => {
    const c = collector();
    const s = await scheduler(c.emit);
    const out = await Effect.runPromise(
      parallel(s, [() => Effect.succeed(okText("a")), () => Effect.succeed(okValue({ n: 1 }))]),
    );
    expect(out).toEqual(["a", { n: 1 }]);
  });

  test("degrades a failed leaf to null AFTER emitting leaf-failed (D-008)", async () => {
    const c = collector();
    const s = await scheduler(c.emit);
    const out = await Effect.runPromise(
      parallel(s, [
        () => Effect.succeed(okText("a")),
        () => Effect.succeed(failed("boom")),
        () => Effect.succeed(okText("c")),
      ]),
    );
    expect(out).toEqual(["a", null, "c"]);
    expect(c.failures).toEqual(["boom"]);
  });

  test("strict mode (onError:'fail') rejects the batch with a typed WorkflowRunError", async () => {
    const c = collector();
    const s = await scheduler(c.emit);
    const exit = await Effect.runPromiseExit(
      parallel(s, [() => Effect.succeed(okText("a")), () => Effect.succeed(failed("boom"))], {
        onError: "fail",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error.reason).toBe("strict-failure");
    }
    // The leaf-failed event still fired before the reject.
    expect(c.failures).toEqual(["boom"]);
  });

  test("bounds concurrency to the cap (excess queues)", async () => {
    const c = collector();
    const s = await scheduler(c.emit, { concurrency: 2 });
    let running = 0;
    let max = 0;
    const thunk = () =>
      Effect.gen(function* () {
        running++;
        max = Math.max(max, running);
        yield* Effect.sleep("10 millis");
        running--;
        return okText("x");
      });
    await Effect.runPromise(
      parallel(
        s,
        Array.from({ length: 6 }, () => thunk),
      ),
    );
    expect(max).toBe(2);
  });

  test("the lifetime cap is a hard backstop", async () => {
    const c = collector();
    const s = await scheduler(c.emit, { maxTotalLeaves: 2 });
    const exit = await Effect.runPromiseExit(
      parallel(s, [
        () => Effect.succeed(okText("a")),
        () => Effect.succeed(okText("b")),
        () => Effect.succeed(okText("c")),
      ]),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error.reason).toBe("lifetime-cap");
    }
  });

  test("rejects a call larger than the per-call cap", async () => {
    const c = collector();
    const s = await scheduler(c.emit);
    const thunks = Array.from(
      { length: MAX_ITEMS_PER_CALL + 1 },
      () => () => Effect.succeed(okText("x")),
    );
    const exit = await Effect.runPromiseExit(parallel(s, thunks));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error.reason).toBe("call-too-large");
    }
  });
});

describe("pipeline - per-item staged flow", () => {
  test("threads each item through its stages and returns the last value", async () => {
    const c = collector();
    const s = await scheduler(c.emit);
    const out = await Effect.runPromise(
      pipeline(
        s,
        [1, 2],
        [
          (_prev, item) => Effect.succeed(okValue(item * 10)),
          (prev) => Effect.succeed(okValue((prev as number) + 1)),
        ],
      ),
    );
    expect(out).toEqual([11, 21]);
  });

  test("a failed stage drops that item to null (emitting) and skips its remaining stages", async () => {
    const c = collector();
    const s = await scheduler(c.emit);
    let stage2Runs = 0;
    const out = await Effect.runPromise(
      pipeline(
        s,
        ["good", "bad"],
        [
          (_prev, item) => Effect.succeed(item === "bad" ? failed("stage1 bad") : okText(item)),
          (prev) =>
            Effect.sync(() => {
              stage2Runs++;
              return okText(`${prev as string}!`);
            }),
        ],
      ),
    );
    expect(out).toEqual(["good!", null]);
    expect(stage2Runs).toBe(1); // the bad item never reached stage 2
    expect(c.failures).toEqual(["stage1 bad"]);
  });

  test("a legitimate null-valued success does NOT truncate the chain (only a drop does)", async () => {
    const c = collector();
    const s = await scheduler(c.emit);
    let stage2Runs = 0;
    const out = await Effect.runPromise(
      pipeline(
        s,
        ["x"],
        [
          () => Effect.succeed(okValue(null)), // succeeds with value null
          (prev) =>
            Effect.sync(() => {
              stage2Runs++;
              return okText(`after-${prev}`);
            }),
        ],
      ),
    );
    expect(out).toEqual(["after-null"]); // stage 2 ran despite the null stage-1 value
    expect(stage2Runs).toBe(1);
  });
});

describe("phase / log", () => {
  test("emit their progress events", async () => {
    const c = collector();
    const s = await scheduler(c.emit);
    await Effect.runPromise(phase(s, "Review"));
    await Effect.runPromise(workflowLog(s, "starting"));
    expect(c.phases).toEqual(["Review"]);
    expect(c.logs).toEqual(["starting"]);
  });
});
