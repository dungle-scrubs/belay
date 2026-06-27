import type { TurnStop } from "@trevor/session";

/**
 * Pure adaptive turn-termination policy.
 *
 * The evaluator separates two axes that used to be collapsed into one step count:
 * context pressure (how full the model window is) and loop health (whether the
 * tool loop is still making progress). The fixed step ceiling remains a high
 * circuit breaker; at low context it pauses with diagnostics instead of posing
 * as a normal answer.
 */

export interface TurnPolicyObservation {
  readonly steps: number;
  readonly maxSteps: number;
  readonly inputTokens: number;
  readonly contextWindow: number;
  readonly contextBudgetFraction: number;
  readonly repeatedToolName?: string;
  readonly repeatedToolRounds: number;
  readonly providerDiagnostic?: {
    readonly reason: string;
    readonly retryable: boolean;
    readonly phase: string;
  };
}

export type TurnPolicyAction =
  | { readonly type: "continue"; readonly debug: TurnPolicyDebug }
  | { readonly type: "synthesize"; readonly stop: TurnStop; readonly debug: TurnPolicyDebug }
  | { readonly type: "pause"; readonly stop: TurnStop; readonly debug: TurnPolicyDebug }
  | { readonly type: "fail"; readonly stop: TurnStop; readonly debug: TurnPolicyDebug };

export interface TurnPolicyDebug {
  readonly selected: string;
  readonly alternatives: readonly string[];
  readonly pressure: number;
  readonly reason: string;
}

const LOOP_STALL_ROUNDS = 6;

function contextPressure(inputTokens: number, contextWindow: number): number {
  return contextWindow > 0 ? inputTokens / contextWindow : 0;
}

function stopContext(obs: TurnPolicyObservation) {
  const pressure = contextPressure(obs.inputTokens, obs.contextWindow);
  return obs.contextWindow > 0
    ? {
        inputTokens: obs.inputTokens,
        contextWindow: obs.contextWindow,
        pressure,
      }
    : undefined;
}

function withDebug(
  selected: string,
  obs: TurnPolicyObservation,
  alternatives: readonly string[],
  reason: string,
): TurnPolicyDebug {
  return {
    selected,
    alternatives,
    pressure: contextPressure(obs.inputTokens, obs.contextWindow),
    reason,
  };
}

export function evaluateTurnTermination(obs: TurnPolicyObservation): TurnPolicyAction {
  const pressure = contextPressure(obs.inputTokens, obs.contextWindow);
  const overContext =
    obs.contextWindow > 0 && obs.inputTokens >= obs.contextBudgetFraction * obs.contextWindow;
  const overSteps = obs.steps >= obs.maxSteps;
  const stalled = obs.repeatedToolRounds >= LOOP_STALL_ROUNDS && obs.repeatedToolName !== undefined;
  const alternatives = [
    overContext ? "context_pressure" : "context_ok",
    stalled ? "loop_stalled" : "loop_healthy",
    overSteps ? "step_backstop" : "step_budget_remaining",
  ];

  if (obs.providerDiagnostic) {
    return {
      type: obs.providerDiagnostic.retryable ? "pause" : "fail",
      stop: {
        cause: "provider_protocol_anomaly",
        action: obs.providerDiagnostic.retryable ? "paused" : "failed",
        summary: `Provider protocol anomaly during ${obs.providerDiagnostic.phase}: ${obs.providerDiagnostic.reason}`,
        steps: obs.steps,
        ...(stopContext(obs) ? { context: stopContext(obs) } : {}),
      },
      debug: withDebug(
        "provider_protocol_anomaly",
        obs,
        alternatives,
        "provider diagnostics outrank budget explanations",
      ),
    };
  }

  if (overContext) {
    return {
      type: "synthesize",
      stop: {
        cause: "context_pressure",
        action: "synthesized",
        summary: `Context pressure reached ${(pressure * 100).toFixed(1)}%; synthesizing before opening more tools.`,
        steps: obs.steps,
        ...(stopContext(obs) ? { context: stopContext(obs) } : {}),
      },
      debug: withDebug(
        "context_pressure",
        obs,
        alternatives,
        "context pressure outranks the raw step backstop",
      ),
    };
  }

  if (stalled) {
    return {
      type: "pause",
      stop: {
        cause: "loop_stalled",
        action: "paused",
        summary: `Paused after ${obs.repeatedToolRounds} repeated ${obs.repeatedToolName} tool rounds without enough progress.`,
        steps: obs.steps,
        ...(stopContext(obs) ? { context: stopContext(obs) } : {}),
      },
      debug: withDebug(
        "loop_stalled",
        obs,
        alternatives,
        "repeated tool rounds beat raw step count",
      ),
    };
  }

  if (overSteps) {
    return {
      type: "pause",
      stop: {
        cause: "step_backstop",
        action: "paused",
        summary: `Paused at the ${obs.maxSteps}-step backstop before context pressure.`,
        steps: obs.steps,
        ...(stopContext(obs) ? { context: stopContext(obs) } : {}),
      },
      debug: withDebug(
        "step_backstop",
        obs,
        alternatives,
        "fixed step ceiling is a runaway circuit breaker",
      ),
    };
  }

  return {
    type: "continue",
    debug: withDebug("continue", obs, alternatives, "no stop condition selected"),
  };
}
