import assert from "node:assert/strict";
import { test } from "vitest";
import { evaluateTurnTermination, type TurnPolicyObservation } from "./turn-policy";

const base: TurnPolicyObservation = {
  steps: 1,
  maxSteps: 32,
  inputTokens: 1_000,
  contextWindow: 1_000_000,
  contextBudgetFraction: 0.8,
  repeatedToolRounds: 0,
};

test("context pressure returns context_pressure and a synthesize action", () => {
  const result = evaluateTurnTermination({
    ...base,
    steps: 4,
    inputTokens: 820_000,
    contextWindow: 1_000_000,
  });
  assert.equal(result.type, "synthesize");
  assert.equal(result.type === "synthesize" && result.stop.cause, "context_pressure");
  assert.equal(result.type === "synthesize" && result.stop.action, "synthesized");
  assert.equal(result.type === "synthesize" && result.stop.context?.pressure, 0.82);
});

test("low-context max-step backstop pauses instead of reporting an ordinary answer", () => {
  const result = evaluateTurnTermination({
    ...base,
    steps: 32,
    inputTokens: 89_022,
    contextWindow: 1_000_000,
  });
  assert.equal(result.type, "pause");
  assert.equal(result.type === "pause" && result.stop.cause, "step_backstop");
  assert.equal(result.type === "pause" && result.stop.action, "paused");
  assert.equal(result.type === "pause" && result.stop.context?.pressure, 0.089022);
});

/**
 * 02.17: with an emergency ceiling supplied, the step backstop becomes a re-evaluation CHECKPOINT.
 * At the adaptive budget, below the ceiling, with context advancing, the turn auto-CONTINUES (the
 * MiniMax-M3 case: many cheap tools, ~20% pressure, paused prematurely at 64 steps). The ceiling and
 * the progress guard are the only terminating gates on the step axis.
 */
test("a low-pressure at-budget turn checkpoints (auto-continues) instead of pausing", () => {
  const result = evaluateTurnTermination({
    ...base,
    steps: 64,
    maxSteps: 64,
    emergencyMaxSteps: 256,
    contextAdvanced: true,
    inputTokens: 207_000, // ~20.7% of a 1M window - plenty of room
    contextWindow: 1_000_000,
  });
  assert.equal(result.type, "checkpoint", "auto-continue, not a step_backstop pause");
  assert.equal(result.debug.selected, "step_checkpoint");
});

test("a turn at the emergency ceiling still pauses with step_backstop (runaway guard)", () => {
  const result = evaluateTurnTermination({
    ...base,
    steps: 256,
    maxSteps: 256,
    emergencyMaxSteps: 256,
    contextAdvanced: true,
    inputTokens: 207_000,
    contextWindow: 1_000_000,
  });
  assert.equal(result.type, "pause");
  assert.equal(result.type === "pause" && result.stop.cause, "step_backstop");
  assert.match(result.type === "pause" ? result.stop.summary : "", /emergency ceiling/);
});

test("a checkpoint with no context advance falls back to a pause (progress guard)", () => {
  const result = evaluateTurnTermination({
    ...base,
    steps: 64,
    maxSteps: 64,
    emergencyMaxSteps: 256,
    contextAdvanced: false, // context went flat across the window - a diverse-no-op-tool loop
    inputTokens: 207_000,
    contextWindow: 1_000_000,
  });
  assert.equal(result.type, "pause");
  assert.equal(result.type === "pause" && result.stop.cause, "step_backstop");
  assert.match(result.type === "pause" ? result.stop.summary : "", /stopped advancing/);
});

test("with NO emergency ceiling supplied the legacy single-axis backstop pause is unchanged", () => {
  // Direct-gate callers that don't opt into checkpoints keep the old behavior (reaching maxSteps pauses).
  const result = evaluateTurnTermination({ ...base, steps: 64, maxSteps: 64 });
  assert.equal(result.type, "pause");
  assert.equal(result.type === "pause" && result.stop.cause, "step_backstop");
  assert.match(
    result.type === "pause" ? result.stop.summary : "",
    /backstop before context pressure/,
  );
});

test("repeated no-progress tool cycles return loop_stalled", () => {
  const result = evaluateTurnTermination({
    ...base,
    steps: 6,
    repeatedToolName: "grep",
    repeatedToolRounds: 6,
  });
  assert.equal(result.type, "pause");
  assert.equal(result.type === "pause" && result.stop.cause, "loop_stalled");
});

test("provider diagnostics can return provider_protocol_anomaly", () => {
  const result = evaluateTurnTermination({
    ...base,
    providerDiagnostic: {
      reason: "malformed tool call JSON",
      retryable: false,
      phase: "model-step",
    },
  });
  assert.equal(result.type, "fail");
  assert.equal(result.type === "fail" && result.stop.cause, "provider_protocol_anomaly");
});

test("debug snapshots explain the selected cause and rejected alternatives", () => {
  const result = evaluateTurnTermination({
    ...base,
    steps: 32,
  });
  assert.equal(result.debug.selected, "step_backstop");
  assert.ok(result.debug.alternatives.includes("context_ok"));
  assert.ok(result.debug.alternatives.includes("step_backstop"));
  assert.match(result.debug.reason, /circuit breaker/);
});
