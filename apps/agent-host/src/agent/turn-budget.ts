/**
 * Pure dynamic turn-budget policy (D-009…D-013).
 *
 * Trevor used to cap every turn at a static 32-step backstop regardless of the model, so a
 * large-context model paused at exactly 32 steps even at trivial context pressure with plenty of room
 * left. This module derives an adaptive step budget from facts the loop already has - served context
 * window, prompt pressure, repeated-tool progress, and reasoning level - and keeps a separate, finite
 * emergency ceiling so a broken loop can never run forever when telemetry is missing or wrong.
 *
 * It is intentionally pure: it imports no provider and reads no I/O. `loop.ts` feeds it live facts and
 * passes `effectiveMaxSteps` into the turn-termination gate; `turn-policy.ts` stays ignorant of how the
 * number was derived (D-019). The constants below are the whole tuning surface (D-021…D-024).
 *
 * Responsible for: deriving the adaptive per-turn step budget from window, pressure, progress,
 * and reasoning facts.
 * Not for: comparing steps against the budget - the termination gate in turn-policy.ts.
 */

/** Base healthy step budget per served context-window tier (D-021). Ordered high→low so the first
 *  tier whose `minWindow` the window meets wins. Context window is the dominant scale signal, so the
 *  budget keys off generic tiers rather than a per-provider table. Thresholds are decimal token
 *  counts (a "1M context" model serves 1,000,000 tokens). */
const CONTEXT_TIERS: readonly {
  readonly minWindow: number;
  readonly base: number;
  readonly label: string;
}[] = [
  { minWindow: 1_000_000, base: 96, label: ">=1M" },
  { minWindow: 512_000, base: 64, label: "512k-1M" },
  { minWindow: 128_000, base: 48, label: "128k-512k" },
  { minWindow: 32_000, base: 32, label: "32k-128k" },
  { minWindow: 1, base: 24, label: "<32k" },
];

/** Conservative budget when the served context window is unknown, missing, or invalid (D-021 row 1).
 *  Also the "ordinary fallback" the emergency ceiling must stay above (D-011). */
export const FALLBACK_MAX_STEPS = 32;

/** Absolute runaway ceiling, independent of the adaptive budget (D-011). Above every healthy tier and
 *  the unknown-telemetry fallback, and finite, so a pathological loop or bad telemetry can never spin.
 *  Raised 128 -> 256 (02.17 D-004): the step backstop is now a re-evaluation CHECKPOINT (auto-continue
 *  at the adaptive budget when context has room and is advancing) rather than a hard pause, so this
 *  ceiling is the SOLE finite step-axis terminating stop and gets more headroom before it fires. */
export const EMERGENCY_MAX_STEPS = 256;

/** Floor for the adaptive budget so a turn always gets real room before pausing, even when penalties
 *  stack. The emergency ceiling still wins over this floor when it is set lower (e.g. a test override). */
const MIN_EFFECTIVE_STEPS = 8;

/** Below this fraction of the way to the context gate, the tier fully controls the budget; above it,
 *  context pressure shrinks the budget toward the floor as the prompt nears the gate (D-022). 0.5 means
 *  the tier holds until the prompt is half-way to the gate, then pressure progressively wins. */
const PRESSURE_COMFORT = 0.5;

/** Budget the context-pressure shrink converges to right at the gate (D-022); the context-pressure
 *  stop in turn-policy takes over from there. */
const PRESSURE_FLOOR_STEPS = 12;

/** Repeated same-tool rounds begin penalizing the budget here - below the loop-stall gate - so a
 *  near-stalled loop loses room before the stall stop fires (D-023). */
const REPEATED_TOOL_PENALTY_START = 3;

/** The loop-stall gate turn-policy enforces; the repeated-tool penalty ramps to full as rounds reach it. */
const LOOP_STALL_ROUNDS = 6;

/** Maximum fraction of the budget the repeated-tool penalty removes as rounds reach the stall gate. */
const REPEATED_TOOL_MAX_CUT = 0.5;

/** Maximum fraction the reasoning penalty removes at the highest level; small so high reasoning costs a
 *  little budget but never collapses large-context work back to the fallback (D-024). */
const REASONING_MAX_PENALTY = 0.15;

/** Whether the served usage telemetry is usable, absent, or corrupt - drives the conservative fallback
 *  and is recorded so a postmortem can tell "healthy budget exhausted" from "telemetry fallback" (D-026). */
export type TelemetryQuality = "ok" | "missing" | "invalid";

/** Live facts the loop already holds; everything the derivation needs (D-020). `emergencyMaxSteps` is
 *  the loop's absolute ceiling (config), optional so the pure default applies in tests. */
export interface TurnBudgetInput {
  readonly providerId: string;
  readonly providerKind: "local" | "cloud";
  readonly model: string;
  readonly reasoning?: string;
  readonly reasoningLevels: readonly string[];
  readonly inputTokens: number;
  readonly contextWindow: number;
  readonly contextBudgetFraction: number;
  readonly repeatedToolName?: string;
  readonly repeatedToolRounds: number;
  readonly emergencyMaxSteps?: number;
}

/** Structured debug facts behind the derived number (D-017, D-026): enough to reconstruct the decision
 *  without re-running the heuristic. `pressureBudget` is the budget after pressure scaling; the two
 *  penalties are the step counts each removed. */
export interface TurnBudgetFactors {
  readonly providerId: string;
  readonly providerKind: "local" | "cloud";
  readonly model: string;
  readonly telemetryQuality: TelemetryQuality;
  readonly contextTier: string;
  readonly contextWindow: number;
  readonly baseBudget: number;
  readonly pressure: number;
  readonly pressureBudget: number;
  readonly repeatedToolRounds: number;
  readonly repeatedToolPenalty: number;
  readonly reasoningPenalty: number;
}

/** The derived budget: the adaptive ordinary limit, the separate absolute ceiling, a short diagnostic
 *  reason for stop summaries, and the structured factors for debug logs. */
export interface TurnBudget {
  readonly effectiveMaxSteps: number;
  readonly emergencyMaxSteps: number;
  readonly reason: string;
  readonly factors: TurnBudgetFactors;
}

export function deriveTurnBudget(input: TurnBudgetInput): TurnBudget {
  const emergencyMaxSteps = normalizeEmergency(input.emergencyMaxSteps);
  const telemetryQuality = classifyTelemetry(input.inputTokens, input.contextWindow);
  const tier =
    telemetryQuality === "ok"
      ? tierForWindow(input.contextWindow)
      : { base: FALLBACK_MAX_STEPS, label: "unknown" };
  const pressure = telemetryQuality === "ok" ? input.inputTokens / input.contextWindow : 0;

  const pressureBudget = applyPressure(tier.base, pressure, input.contextBudgetFraction);
  const repeatedToolPenalty = repeatedToolStepsCut(
    pressureBudget,
    input.repeatedToolName,
    input.repeatedToolRounds,
  );
  const afterRepeated = pressureBudget - repeatedToolPenalty;
  const reasoningPenalty = reasoningStepsCut(afterRepeated, input.reasoning, input.reasoningLevels);
  const afterReasoning = afterRepeated - reasoningPenalty;

  // Floor so a turn always gets real room, then the absolute ceiling wins even over the floor (a low
  // emergency override must be able to pin the budget below the floor).
  const floored = Math.max(MIN_EFFECTIVE_STEPS, Math.round(afterReasoning));
  const effectiveMaxSteps = Math.min(floored, emergencyMaxSteps);

  return {
    effectiveMaxSteps,
    emergencyMaxSteps,
    reason: describeReason(
      telemetryQuality,
      tier.label,
      pressure,
      input.repeatedToolRounds,
      effectiveMaxSteps,
    ),
    factors: {
      providerId: input.providerId,
      providerKind: input.providerKind,
      model: input.model,
      telemetryQuality,
      contextTier: tier.label,
      contextWindow: input.contextWindow,
      baseBudget: tier.base,
      pressure,
      pressureBudget,
      repeatedToolRounds: input.repeatedToolRounds,
      repeatedToolPenalty,
      reasoningPenalty,
    },
  };
}

/** A finite, positive ceiling: a missing or corrupt override falls back to the module default so the
 *  ceiling is never disabled (D-011, M2). */
function normalizeEmergency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return EMERGENCY_MAX_STEPS;
  }
  return Math.floor(value);
}

function classifyTelemetry(inputTokens: number, contextWindow: number): TelemetryQuality {
  if (
    !Number.isFinite(contextWindow) ||
    !Number.isFinite(inputTokens) ||
    contextWindow < 0 ||
    inputTokens < 0
  ) {
    return "invalid";
  }
  return contextWindow === 0 ? "missing" : "ok";
}

function tierForWindow(contextWindow: number): { base: number; label: string } {
  for (const tier of CONTEXT_TIERS) {
    if (contextWindow >= tier.minWindow) {
      return { base: tier.base, label: tier.label };
    }
  }
  return { base: FALLBACK_MAX_STEPS, label: "unknown" };
}

/** At low pressure the tier base controls; once the prompt passes the comfort band on its way to the
 *  gate, the budget interpolates down to the pressure floor (D-022). */
function applyPressure(base: number, pressure: number, gateFraction: number): number {
  if (gateFraction <= 0) {
    return base;
  }
  const gateProgress = clamp(pressure / gateFraction, 0, 1);
  if (gateProgress <= PRESSURE_COMFORT) {
    return base;
  }
  const t = (gateProgress - PRESSURE_COMFORT) / (1 - PRESSURE_COMFORT);
  return Math.min(base, lerp(base, PRESSURE_FLOOR_STEPS, t));
}

/** Steps removed for repeated same-tool rounds: zero until the penalty start, then ramping to
 *  `REPEATED_TOOL_MAX_CUT` of the budget as rounds reach the stall gate (D-023). */
function repeatedToolStepsCut(
  budget: number,
  toolName: string | undefined,
  rounds: number,
): number {
  if (!toolName || rounds < REPEATED_TOOL_PENALTY_START) {
    return 0;
  }
  const span = LOOP_STALL_ROUNDS - REPEATED_TOOL_PENALTY_START + 1;
  const approach = clamp((rounds - REPEATED_TOOL_PENALTY_START + 1) / span, 0, 1);
  return budget * approach * REPEATED_TOOL_MAX_CUT;
}

/** Steps removed for reasoning effort: scales with the level's rank in the ordered `levels`
 *  (low→high), capped at `REASONING_MAX_PENALTY` so it stays small (D-024). */
function reasoningStepsCut(
  budget: number,
  reasoning: string | undefined,
  levels: readonly string[],
): number {
  if (!reasoning || levels.length <= 1) {
    return 0;
  }
  const index = levels.indexOf(reasoning);
  if (index <= 0) {
    return 0;
  }
  const fraction = index / (levels.length - 1);
  return budget * fraction * REASONING_MAX_PENALTY;
}

function describeReason(
  quality: TelemetryQuality,
  tierLabel: string,
  pressure: number,
  repeatedToolRounds: number,
  effectiveMaxSteps: number,
): string {
  if (quality !== "ok") {
    return `${quality} telemetry: conservative ${effectiveMaxSteps}-step budget`;
  }
  const parts = [`${tierLabel} context`];
  if (pressure > 0) {
    parts.push(`${(pressure * 100).toFixed(1)}% pressure`);
  }
  if (repeatedToolRounds >= REPEATED_TOOL_PENALTY_START) {
    parts.push(`${repeatedToolRounds} repeated rounds`);
  }
  return `${parts.join(", ")} -> ${effectiveMaxSteps} steps`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}
