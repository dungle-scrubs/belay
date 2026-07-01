import type { LoopSpec } from "@trevor/session";
import { describe, expect, it } from "vitest";
import {
  createLoopIterationRunner,
  defaultProcessSeam,
  type LoopRunnerSeams,
} from "../../src/loop/runner";

/**
 * Loop iteration runner (plan 17, M5): each runner type dispatches to its execution path. Prompt/background
 * paths use fake seams (the real ones are the live turn machine + background agent); the process path runs
 * the REAL shared runCommand, so timeout/cap/redaction are exercised end to end.
 */

const base = { durability: "session", action: "", max: 1 } as const;

/** Seams that record which one ran, so a dispatch is provable. */
function recordingSeams(): { seams: LoopRunnerSeams; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    seams: {
      runProcess: (command) => {
        calls.push(`process:${command}`);
        return Promise.resolve({ ok: true, output: "ran" });
      },
      runPrompt: (prompt) => {
        calls.push(`prompt:${prompt}`);
        return Promise.resolve({ ok: true, summary: "answered" });
      },
      runBackground: (prompt) => {
        calls.push(`background:${prompt}`);
        return Promise.resolve({ ok: true, summary: "spawned + finished" });
      },
    },
  };
}

describe("loop iteration runner dispatch (M5)", () => {
  it("a current-session prompt loop runs through the prompt seam", async () => {
    const { seams, calls } = recordingSeams();
    const runner = createLoopIterationRunner(seams);
    const spec: LoopSpec = { ...base, runner: "current_session_prompt", action: "summarize inbox" };
    const outcome = await runner.run(spec);
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toBe("answered");
    expect(calls).toEqual(["prompt:summarize inbox"]);
  });

  it("a background-agent prompt loop runs through the background seam", async () => {
    const { seams, calls } = recordingSeams();
    const runner = createLoopIterationRunner(seams);
    const spec: LoopSpec = { ...base, runner: "background_agent", action: "sweep dead links" };
    const outcome = await runner.run(spec);
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(["background:sweep dead links"]);
  });

  it("a process loop runs through the process seam", async () => {
    const { seams, calls } = recordingSeams();
    const runner = createLoopIterationRunner(seams);
    const spec: LoopSpec = { ...base, runner: "process", action: "curl -sf localhost/health" };
    await runner.run(spec);
    expect(calls).toEqual(["process:curl -sf localhost/health"]);
  });

  it("propagates a failed iteration as ok:false with an error", async () => {
    const runner = createLoopIterationRunner({
      runProcess: () => Promise.resolve({ ok: false, output: "boom" }),
      runPrompt: () => Promise.resolve({ ok: true, summary: "" }),
      runBackground: () => Promise.resolve({ ok: true, summary: "" }),
    });
    const outcome = await runner.run({ ...base, runner: "process", action: "false" });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("boom");
  });
});

describe("loop process runner over the REAL command boundary (M5)", () => {
  const runner = createLoopIterationRunner({
    runProcess: defaultProcessSeam,
    runPrompt: () => Promise.resolve({ ok: true, summary: "" }),
    runBackground: () => Promise.resolve({ ok: true, summary: "" }),
  });

  it("runs a real shell command and reports success with a redacted summary", async () => {
    const outcome = await runner.run({ ...base, runner: "process", action: "echo loop-ran" });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain("loop-ran");
  });

  it("reports a non-zero exit as a failed iteration", async () => {
    const outcome = await runner.run({
      ...base,
      runner: "process",
      action: 'node -e "process.exit(3)"',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeDefined();
  });

  it("redacts + caps a large output so a status line cannot carry a wall of text", async () => {
    const outcome = await runner.run({
      ...base,
      runner: "process",
      action: "node -e \"console.log('x'.repeat(500))\"",
    });
    expect(outcome.ok).toBe(true);
    // 200-char preview + a single ellipsis; never the full 500.
    expect(outcome.summary.length).toBeLessThanOrEqual(201);
    expect(outcome.summary.endsWith("…")).toBe(true);
  });
}, 20_000);
