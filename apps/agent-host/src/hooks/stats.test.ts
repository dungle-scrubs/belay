import { describe, expect, test } from "vitest";
import type { HookDefinition } from "./config";
import { hookExecutionOutcome } from "./results";
import type { HookExecution } from "./runner";
import { createHookStats, SLOW_HOOK_THRESHOLD_RATIO } from "./stats";

const guard: HookDefinition = {
  id: "guard",
  event: "PreToolUse",
  command: "./check.sh",
  args: [],
  timeoutMs: 1_000,
  enabled: true,
  source: "project",
};

const review: HookDefinition = { ...guard, id: "review", event: "Stop", source: "user" };

function execution(overrides: Partial<HookExecution> = {}): HookExecution {
  return {
    stdout: { text: '{"decision":"allow"}', truncated: false },
    stderr: { text: "", truncated: false },
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 10,
    ...overrides,
  };
}

function record(
  stats: ReturnType<typeof createHookStats>,
  hook: HookDefinition,
  run: HookExecution,
): void {
  stats.record(hook, run, hookExecutionOutcome(run));
}

describe("createHookStats - counters accumulate per hook", () => {
  test("runs, timeouts, failures, and slow runs accumulate across recordings", () => {
    const stats = createHookStats();

    record(stats, guard, execution({ durationMs: 900 })); // slow: > 80% of 1000ms
    record(stats, guard, execution({ timedOut: true, exitCode: null, durationMs: 1_050 }));
    record(stats, guard, execution({ exitCode: 2, durationMs: 15 }));
    record(stats, guard, execution({ durationMs: 20 }));

    expect(stats.snapshot()).toEqual([
      {
        key: "project:guard",
        runs: 4,
        slowRuns: 1,
        timeouts: 1,
        failures: 1,
        invalidOutputs: 0,
        lastDurationMs: 20,
      },
    ]);
  });

  test("invalid JSON and invalid decisions count as invalid outputs", () => {
    const stats = createHookStats();

    record(stats, guard, execution({ stdout: { text: "nope", truncated: false } }));
    record(stats, guard, execution({ stdout: { text: '{"decision":"maybe"}', truncated: false } }));

    const [entry] = stats.snapshot();
    expect(entry).toMatchObject({ runs: 2, invalidOutputs: 2 });
  });

  test("the last run's diagnostic reason is exposed, cleared by a clean run", () => {
    const stats = createHookStats();

    record(stats, guard, execution({ timedOut: true, exitCode: null }));
    expect(stats.snapshot()[0]).toMatchObject({ lastDiagnostic: "timeout" });

    record(stats, guard, execution());
    expect(stats.snapshot()[0]?.lastDiagnostic).toBeUndefined();
  });
});

describe("createHookStats - slow-run threshold (80% of the hook's timeout)", () => {
  test("the threshold ratio is 0.8", () => {
    expect(SLOW_HOOK_THRESHOLD_RATIO).toBe(0.8);
  });

  test("a run at exactly the threshold is not slow; just over is", () => {
    const stats = createHookStats();

    record(stats, guard, execution({ durationMs: 800 }));
    record(stats, guard, execution({ durationMs: 801 }));

    expect(stats.snapshot()[0]).toMatchObject({ slowRuns: 1 });
  });

  test("a timed-out run counts as a timeout, not additionally as slow", () => {
    const stats = createHookStats();

    record(stats, guard, execution({ timedOut: true, exitCode: null, durationMs: 1_100 }));

    expect(stats.snapshot()[0]).toMatchObject({ timeouts: 1, slowRuns: 0 });
  });
});

describe("createHookStats - snapshot shape for Doctor (D-009)", () => {
  test("hooks are tracked per approval key and the snapshot is sorted by key", () => {
    const stats = createHookStats();

    record(stats, review, execution());
    record(stats, guard, execution());

    expect(stats.snapshot().map((entry) => entry.key)).toEqual(["project:guard", "user:review"]);
  });

  test("the snapshot is a copy - later recordings do not mutate an earlier snapshot", () => {
    const stats = createHookStats();

    record(stats, guard, execution());
    const before = stats.snapshot();
    record(stats, guard, execution());

    expect(before[0]?.runs).toBe(1);
    expect(stats.snapshot()[0]?.runs).toBe(2);
  });

  test("an empty recorder snapshots to an empty list", () => {
    expect(createHookStats().snapshot()).toEqual([]);
  });
});
