import assert from "node:assert/strict";
import { ProcessRegistry, runPromotable } from "@belay/agent-host/testing";
import { afterEach, beforeEach, test } from "vitest";

/**
 * S-PROMOTE (plan 09, hermetic): the background-job promotion runtime end-to-end - the exact path the
 * bash tool + prompt-shell lane drive. An eligible long-running command crosses the threshold and becomes
 * a tracked `pN` job; the supervisor announces every change (the host re-announce hook), the job snapshot
 * the support panel renders updates through completion, and stopping it transitions the snapshot to
 * killed. Real short commands in a real cwd. The UI-level flow (panel row + detail takeover) is a deferred
 * manual EZE - the headless browser/Storybook lane lands with plan 09.2.
 */

const CWD = process.cwd();
let reg: ProcessRegistry;
beforeEach(() => {
  reg = new ProcessRegistry();
});
afterEach(() => reg.killAll());

test("a long shell command promotes to a tracked job, announces changes, and kills cleanly", async () => {
  const announces: number[] = [];
  reg.onChange = () => announces.push(reg.snapshots().length);

  const result = await runPromotable(reg, "echo starting && sleep 5", CWD, {
    enabled: true,
    thresholdMs: 80,
    origin: { source: "bash", runId: "r1", callId: "c1" },
  });

  // Promoted to a tracked pN, with the panel-facing snapshot the web renders.
  assert.equal(result.decision, "promote");
  const jobId = result.jobId ?? "";
  assert.match(jobId, /^p\d+$/u);
  const running = reg.snapshots().find((s) => s.id === jobId);
  assert.equal(running?.status, "running");
  assert.equal(running?.source, "bash");
  assert.equal(running?.runId, "r1");
  assert.ok(running?.promotedAt, "the job is stamped promoted");
  assert.match(
    running?.tail ?? "",
    /starting/,
    "output captured before promotion rides the snapshot",
  );

  // The supervisor announced on start + promote (the host re-announce hook fires, so the panel updates).
  assert.ok(announces.length >= 1, "onChange fired for the host to re-announce");

  // Stopping the job (the support panel's /jobs-stop path) transitions the snapshot through completion.
  const before = announces.length;
  reg.kill(jobId);
  assert.equal(reg.snapshots().find((s) => s.id === jobId)?.status, "killed");
  assert.ok(announces.length > before, "the kill announced a change too");
});

test("a fast command never promotes and leaves no job for the panel", async () => {
  const result = await runPromotable(reg, "echo quick", CWD, {
    enabled: true,
    thresholdMs: 2000,
    origin: { source: "shell", requestId: "q1" },
  });
  assert.equal(result.decision, "complete");
  assert.match(result.output, /quick/);
  assert.equal(reg.snapshots().length, 0, "no pN tracked for a fast foreground command");
});
