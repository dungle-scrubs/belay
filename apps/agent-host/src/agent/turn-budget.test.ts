import assert from "node:assert/strict";
import { test } from "vitest";
import {
  deriveTurnBudget,
  EMERGENCY_MAX_STEPS,
  FALLBACK_MAX_STEPS,
  type TurnBudgetInput,
} from "./turn-budget";

const base: TurnBudgetInput = {
  providerId: "fake",
  providerKind: "cloud",
  model: "fake-1",
  reasoning: "off",
  reasoningLevels: ["off", "low", "medium", "high"],
  inputTokens: 1_000,
  contextWindow: 1_000_000,
  contextBudgetFraction: 0.8,
  repeatedToolRounds: 0,
};

// M1: context tiers. The served context window is the dominant scale signal (D-021); at low
// pressure each tier's base healthy budget controls.
test("M1: unknown context falls back to the conservative budget", () => {
  const budget = deriveTurnBudget({ ...base, inputTokens: 0, contextWindow: 0 });
  assert.equal(budget.effectiveMaxSteps, FALLBACK_MAX_STEPS);
  assert.equal(budget.factors.telemetryQuality, "missing");
  assert.equal(budget.factors.contextTier, "unknown");
});

test("M1: a small (<32k) context stays conservative", () => {
  const budget = deriveTurnBudget({ ...base, inputTokens: 100, contextWindow: 16_000 });
  assert.equal(budget.effectiveMaxSteps, 24);
  assert.equal(budget.factors.contextTier, "<32k");
});

test("M1: a 32k-128k context keeps the 32-step base", () => {
  const budget = deriveTurnBudget({ ...base, inputTokens: 100, contextWindow: 100_000 });
  assert.equal(budget.effectiveMaxSteps, 32);
  assert.equal(budget.factors.contextTier, "32k-128k");
});

test("M1: a 128k context lifts the base above 32", () => {
  const budget = deriveTurnBudget({ ...base, inputTokens: 100, contextWindow: 128_000 });
  assert.equal(budget.effectiveMaxSteps, 48);
  assert.equal(budget.factors.contextTier, "128k-512k");
});

test("M1: a 512k context lifts the base further", () => {
  const budget = deriveTurnBudget({ ...base, inputTokens: 100, contextWindow: 512_000 });
  assert.equal(budget.effectiveMaxSteps, 64);
  assert.equal(budget.factors.contextTier, "512k-1M");
});

test("M1: a 1M context, low pressure, earns the largest budget", () => {
  const budget = deriveTurnBudget({ ...base, inputTokens: 1_000, contextWindow: 1_000_000 });
  assert.equal(budget.effectiveMaxSteps, 96);
  assert.equal(budget.factors.contextTier, ">=1M");
  assert.ok(budget.effectiveMaxSteps > FALLBACK_MAX_STEPS, "large context is not pinned to 32");
});

// M1: context pressure shrinks the budget as the prompt nears the context gate (D-022).
test("M1: context pressure near the gate shrinks the budget", () => {
  const low = deriveTurnBudget({ ...base, inputTokens: 1_000, contextWindow: 1_000_000 });
  const mid = deriveTurnBudget({ ...base, inputTokens: 600_000, contextWindow: 1_000_000 });
  assert.ok(
    mid.effectiveMaxSteps < low.effectiveMaxSteps,
    "0.6 pressure shrinks below the tier base",
  );
  assert.ok(
    mid.effectiveMaxSteps > FALLBACK_MAX_STEPS,
    "0.6 pressure is still roomier than unknown",
  );
  assert.ok(mid.factors.pressureBudget < mid.factors.baseBudget);
});

test("M1: budget shrinks monotonically as pressure rises toward the gate", () => {
  const at = (input: number) =>
    deriveTurnBudget({ ...base, inputTokens: input, contextWindow: 1_000_000 }).effectiveMaxSteps;
  assert.ok(at(450_000) >= at(550_000));
  assert.ok(at(550_000) >= at(630_000));
});

test("M1: pressure below the comfort band leaves the tier base untouched", () => {
  // 14% pressure is well below half-way to the 80% gate, so the 1M tier base still controls.
  const budget = deriveTurnBudget({ ...base, inputTokens: 140_000, contextWindow: 1_000_000 });
  assert.equal(budget.effectiveMaxSteps, 96);
});

// M1: repeated-tool and high-reasoning penalties (D-023, D-024).
test("M1: repeated same-tool rounds shrink the budget before the stall gate", () => {
  const calm = deriveTurnBudget({ ...base, inputTokens: 1_000, contextWindow: 1_000_000 });
  const looping = deriveTurnBudget({
    ...base,
    inputTokens: 1_000,
    contextWindow: 1_000_000,
    repeatedToolName: "grep",
    repeatedToolRounds: 5,
  });
  assert.ok(looping.effectiveMaxSteps < calm.effectiveMaxSteps);
  assert.ok(looping.factors.repeatedToolPenalty > 0);
});

test("M1: more repeated rounds shrink the budget further", () => {
  const cut = (rounds: number) =>
    deriveTurnBudget({
      ...base,
      inputTokens: 1_000,
      contextWindow: 1_000_000,
      repeatedToolName: "grep",
      repeatedToolRounds: rounds,
    }).effectiveMaxSteps;
  assert.ok(cut(3) >= cut(4));
  assert.ok(cut(4) >= cut(5));
});

test("M1: a lone repeated round below the penalty start is not penalized", () => {
  const budget = deriveTurnBudget({
    ...base,
    inputTokens: 1_000,
    contextWindow: 1_000_000,
    repeatedToolName: "grep",
    repeatedToolRounds: 1,
  });
  assert.equal(budget.effectiveMaxSteps, 96);
  assert.equal(budget.factors.repeatedToolPenalty, 0);
});

test("M1: high reasoning applies a small penalty without collapsing a large budget to 32", () => {
  const off = deriveTurnBudget({ ...base, reasoning: "off", inputTokens: 1_000 });
  const high = deriveTurnBudget({ ...base, reasoning: "high", inputTokens: 1_000 });
  assert.ok(high.effectiveMaxSteps < off.effectiveMaxSteps, "high reasoning costs a little budget");
  assert.ok(
    high.effectiveMaxSteps > FALLBACK_MAX_STEPS,
    "a 1M low-pressure turn at high reasoning stays well above 32",
  );
  assert.ok(high.factors.reasoningPenalty > 0);
});

// M2: emergency ceiling contract (D-011).
test("M2: invalid telemetry falls back to a conservative budget and keeps a finite ceiling", () => {
  const budget = deriveTurnBudget({ ...base, inputTokens: Number.NaN, contextWindow: Number.NaN });
  assert.equal(budget.effectiveMaxSteps, FALLBACK_MAX_STEPS);
  assert.equal(budget.factors.telemetryQuality, "invalid");
  assert.ok(Number.isFinite(budget.emergencyMaxSteps));
});

test("M2: missing telemetry is conservative but still returns the emergency ceiling", () => {
  const budget = deriveTurnBudget({ ...base, inputTokens: 0, contextWindow: 0 });
  assert.equal(budget.effectiveMaxSteps, FALLBACK_MAX_STEPS);
  assert.equal(budget.factors.telemetryQuality, "missing");
  assert.equal(budget.emergencyMaxSteps, EMERGENCY_MAX_STEPS);
});

test("M2: the emergency ceiling is higher than the ordinary fallback but finite", () => {
  const budget = deriveTurnBudget(base);
  assert.ok(budget.emergencyMaxSteps > FALLBACK_MAX_STEPS);
  assert.ok(Number.isFinite(budget.emergencyMaxSteps));
  assert.ok(
    budget.emergencyMaxSteps >= budget.effectiveMaxSteps,
    "the ceiling never sits below the budget",
  );
});

test("M2: a low emergency override clamps the effective budget", () => {
  const budget = deriveTurnBudget({ ...base, emergencyMaxSteps: 3 });
  assert.equal(
    budget.effectiveMaxSteps,
    3,
    "the absolute ceiling wins over a generous tier budget",
  );
  assert.equal(budget.emergencyMaxSteps, 3);
});

test("M2: a non-finite emergency override is ignored for the default ceiling", () => {
  const budget = deriveTurnBudget({ ...base, emergencyMaxSteps: Number.POSITIVE_INFINITY });
  assert.equal(budget.emergencyMaxSteps, EMERGENCY_MAX_STEPS);
});

test("M2: the budget reason distinguishes telemetry fallback from a healthy tier", () => {
  const healthy = deriveTurnBudget({ ...base, inputTokens: 1_000, contextWindow: 1_000_000 });
  const fallback = deriveTurnBudget({ ...base, inputTokens: 0, contextWindow: 0 });
  assert.match(healthy.reason, />=1M/);
  assert.match(fallback.reason, /telemetry/);
});
