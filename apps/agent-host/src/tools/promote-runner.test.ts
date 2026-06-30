import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { ProcessRegistry } from "../process-registry";
import { type PromotableOptions, runPromotable } from "./promote-runner";

/**
 * M3: the promotable shell runner. A command still running at the threshold becomes a tracked `pN` job
 * (preserving its output so far); a fast command completes/fails as a foreground result with no job left
 * behind; a refused command never spawns; and with promotion disabled a long command is a plain timeout.
 * Spawns real short commands in a real cwd with generous thresholds, killed after each test.
 */

const CWD = process.cwd();
const reg = new ProcessRegistry();
afterEach(() => reg.killAll());

function opts(over: Partial<PromotableOptions> = {}): PromotableOptions {
  return {
    enabled: true,
    thresholdMs: 60,
    origin: { source: "bash", runId: "r1", callId: "c1" },
    ...over,
  };
}

describe("runPromotable", () => {
  test("a command still running at the threshold is promoted to a tracked pN job", async () => {
    const result = await runPromotable(reg, "sleep 2", CWD, opts());
    assert.equal(result.decision, "promote");
    assert.match(result.jobId ?? "", /^p\d+$/u);
    const snap = reg.snapshots().find((s) => s.id === result.jobId);
    assert.equal(snap?.status, "running");
    assert.equal(snap?.source, "bash");
    assert.ok(snap?.promotedAt, "the job is stamped promoted");
  });

  test("output already printed before promotion is preserved on the result", async () => {
    const result = await runPromotable(
      reg,
      "echo before-promote && sleep 2",
      CWD,
      opts({ thresholdMs: 120 }),
    );
    assert.equal(result.decision, "promote");
    assert.match(result.output, /before-promote/);
  });

  test("a fast command completes as a foreground result and leaves no job behind", async () => {
    const before = reg.snapshots().length;
    const result = await runPromotable(reg, "true", CWD, opts({ thresholdMs: 2000 }));
    assert.equal(result.decision, "complete");
    assert.equal(result.ok, true);
    assert.equal(result.jobId, undefined);
    assert.equal(reg.snapshots().length, before, "no pN tracked for a finished foreground command");
  });

  test("a fast non-zero command fails (foreground), no job", async () => {
    const result = await runPromotable(reg, "false", CWD, opts({ thresholdMs: 2000 }));
    assert.equal(result.decision, "fail");
    assert.equal(result.ok, false);
    assert.equal(result.jobId, undefined);
  });

  test("a safety-refused command never spawns", async () => {
    const before = reg.snapshots().length;
    const result = await runPromotable(reg, "rm -rf /", CWD, opts());
    assert.equal(result.decision, "refuse");
    assert.equal(reg.snapshots().length, before, "nothing spawned");
  });

  test("with promotion disabled, a long command times out (fail) instead of promoting", async () => {
    const result = await runPromotable(
      reg,
      "sleep 2",
      CWD,
      opts({ enabled: false, thresholdMs: 40 }),
    );
    assert.equal(result.decision, "fail");
    assert.equal(result.jobId, undefined);
  });
});
