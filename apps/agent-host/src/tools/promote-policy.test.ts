import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { decidePromotion, type PromotionInput } from "./promote-policy";

/**
 * M1: the pure promotion policy. It decides refuse / complete / fail / promote, checking the SAME
 * always-prevented safety floor as bash/process first, then resolving by the observed outcome - and only
 * a command still running past the threshold WITH promotion enabled becomes a background job.
 */

function input(over: Partial<PromotionInput> = {}): PromotionInput {
  return {
    command: "sleep 600",
    cwd: "/work",
    source: "bash",
    enabled: true,
    thresholdMs: 30_000,
    outcome: "running-at-threshold",
    ...over,
  };
}

describe("decidePromotion", () => {
  test("an eligible long-running command past the threshold promotes to a background job", () => {
    assert.equal(decidePromotion(input()).decision, "promote");
  });

  test("a safety-refused command never promotes - even running at the threshold with promotion on", () => {
    const r = decidePromotion(input({ command: "rm -rf /" }));
    assert.equal(r.decision, "refuse");
    assert.ok(r.reason.length > 0, "carries the safety-floor reason");
  });

  test("a fast command that finished within the threshold completes", () => {
    assert.equal(decidePromotion(input({ outcome: "completed" })).decision, "complete");
  });

  test("a command that finished non-zero fails", () => {
    assert.equal(decidePromotion(input({ outcome: "failed" })).decision, "fail");
  });

  test("a command at the threshold with promotion DISABLED is a plain timeout (fail), not a job", () => {
    assert.equal(decidePromotion(input({ enabled: false })).decision, "fail");
  });

  test("the same policy + safety floor applies to the prompt-shell lane (source: shell)", () => {
    assert.equal(decidePromotion(input({ source: "shell" })).decision, "promote");
    assert.equal(
      decidePromotion(input({ source: "shell", command: "rm -rf /" })).decision,
      "refuse",
    );
  });
});
