import { hookExecutionOutcome } from "@host/hooks/results";
import { runHook } from "@host/hooks/runner";
import { createHookStats } from "@host/hooks/stats";
import { describe, expect, test } from "vitest";
import { fixtureHook } from "./fixture-config";

/**
 * Hook failure-semantics integration tests (plan 25 M4): the real fixture child driven
 * through runHook + hookExecutionOutcome, proving the D-007 contract end to end - command
 * failure, invalid JSON, and timeout land as NON-BLOCKING diagnostics (never a throw, never a
 * rejection), while an explicit deny/halt from a successful run still blocks - and that the
 * per-hook counters accumulate off real executions.
 *
 * Responsible for: exercising the execution -> outcome -> stats pipeline over ./fixture-hook.
 * Not for: pure outcome/counter matrices - src/hooks/results.test.ts and
 * src/hooks/stats.test.ts own those.
 */

const cwd = import.meta.dirname;

describe("execution outcomes end to end (D-007)", () => {
  test("a non-zero exit becomes a non-blocking command_failed diagnostic", async () => {
    const execution = await runHook(fixtureHook("fail", ["it broke", "2"]), {}, { cwd });
    const outcome = hookExecutionOutcome(execution);

    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "command_failed" });
  });

  test("a hang becomes a non-blocking timeout diagnostic", async () => {
    const execution = await runHook(fixtureHook("hang", [], { timeoutMs: 200 }), {}, { cwd });
    const outcome = hookExecutionOutcome(execution);

    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "timeout" });
  });

  test("non-JSON stdout becomes a non-blocking invalid_json diagnostic", async () => {
    const execution = await runHook(fixtureHook("print", ["all clear!"]), {}, { cwd });
    const outcome = hookExecutionOutcome(execution);

    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "invalid_json" });
  });

  test("a missing executable becomes a non-blocking command_failed diagnostic", async () => {
    const execution = await runHook(
      fixtureHook("argv", [], { command: "/nonexistent/belay-hook-binary" }),
      {},
      { cwd },
    );
    const outcome = hookExecutionOutcome(execution);

    expect(outcome).toMatchObject({ kind: "diagnostic", reason: "command_failed" });
  });

  test("an explicit deny from a successful run still blocks", async () => {
    const denial = JSON.stringify({ decision: "deny", reason: "not on my watch" });
    const execution = await runHook(fixtureHook("print", [denial]), {}, { cwd });
    const outcome = hookExecutionOutcome(execution);

    expect(outcome).toMatchObject({
      kind: "decision",
      decision: { decision: "deny", reason: "not on my watch" },
    });
  });
});

describe("per-hook counters over real executions", () => {
  test("timeouts and failures accumulate into the Doctor snapshot", async () => {
    const stats = createHookStats();
    const hang = fixtureHook("hang", [], { timeoutMs: 200 });
    const fail = fixtureHook("fail", ["boom", "1"]);

    for (const hook of [hang, fail]) {
      const execution = await runHook(hook, {}, { cwd });
      stats.record(
        "project:/repo:fixture",
        hook.timeoutMs,
        execution,
        hookExecutionOutcome(execution),
      );
    }

    // Both fixtures share the id/source, so they land on one per-hook entry.
    expect(stats.snapshot()).toEqual([
      expect.objectContaining({
        key: "project:/repo:fixture",
        runs: 2,
        timeouts: 1,
        failures: 1,
        lastDiagnostic: "command_failed",
      }),
    ]);
  });
});
