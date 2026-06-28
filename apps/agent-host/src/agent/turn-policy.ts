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

interface TurnTerminationAnalysis {
  readonly pressure: number;
  readonly context?: TurnStop["context"];
  readonly overContext: boolean;
  readonly overSteps: boolean;
  readonly stalled: boolean;
  readonly alternatives: readonly string[];
}

interface TurnTerminationDecision {
  readonly stop: TurnStop;
  readonly debug: TurnPolicyDebug;
}

function analyzeTermination(obs: TurnPolicyObservation): TurnTerminationAnalysis {
  const pressure = contextWindowPressure(obs.inputTokens, obs.contextWindow);
  const overContext =
    obs.contextWindow > 0 && obs.inputTokens >= obs.contextBudgetFraction * obs.contextWindow;
  const overSteps = obs.steps >= obs.maxSteps;
  const stalled = obs.repeatedToolRounds >= LOOP_STALL_ROUNDS && obs.repeatedToolName !== undefined;
  return {
    pressure,
    context:
      obs.contextWindow > 0
        ? {
            inputTokens: obs.inputTokens,
            contextWindow: obs.contextWindow,
            pressure,
          }
        : undefined,
    overContext,
    overSteps,
    stalled,
    alternatives: [
      overContext ? "context_pressure" : "context_ok",
      stalled ? "loop_stalled" : "loop_healthy",
      overSteps ? "step_backstop" : "step_budget_remaining",
    ],
  };
}

function contextWindowPressure(inputTokens: number, contextWindow: number): number {
  return contextWindow > 0 ? inputTokens / contextWindow : 0;
}

function withDebug(
  selected: string,
  analysis: TurnTerminationAnalysis,
  reason: string,
): TurnPolicyDebug {
  return {
    selected,
    alternatives: analysis.alternatives,
    pressure: analysis.pressure,
    reason,
  };
}

function decideTermination(obs: TurnPolicyObservation): TurnTerminationDecision | null {
  const analysis = analyzeTermination(obs);
  if (obs.providerDiagnostic) {
    return {
      stop: {
        cause: "provider_protocol_anomaly",
        action: obs.providerDiagnostic.retryable ? "paused" : "failed",
        summary: `Provider protocol anomaly during ${obs.providerDiagnostic.phase}: ${obs.providerDiagnostic.reason}`,
        steps: obs.steps,
        ...(analysis.context ? { context: analysis.context } : {}),
      },
      debug: withDebug(
        "provider_protocol_anomaly",
        analysis,
        "provider diagnostics outrank budget explanations",
      ),
    };
  }

  if (analysis.overContext) {
    return {
      stop: {
        cause: "context_pressure",
        action: "synthesized",
        summary: `Context pressure reached ${(analysis.pressure * 100).toFixed(1)}%; synthesizing before opening more tools.`,
        steps: obs.steps,
        ...(analysis.context ? { context: analysis.context } : {}),
      },
      debug: withDebug(
        "context_pressure",
        analysis,
        "context pressure outranks the raw step backstop",
      ),
    };
  }

  if (analysis.stalled) {
    return {
      stop: {
        cause: "loop_stalled",
        action: "paused",
        summary: `Paused after ${obs.repeatedToolRounds} repeated ${obs.repeatedToolName} tool rounds without enough progress.`,
        steps: obs.steps,
        ...(analysis.context ? { context: analysis.context } : {}),
      },
      debug: withDebug("loop_stalled", analysis, "repeated tool rounds beat raw step count"),
    };
  }

  if (analysis.overSteps) {
    return {
      stop: {
        cause: "step_backstop",
        action: "paused",
        summary: `Paused at the ${obs.maxSteps}-step backstop before context pressure.`,
        steps: obs.steps,
        ...(analysis.context ? { context: analysis.context } : {}),
      },
      debug: withDebug(
        "step_backstop",
        analysis,
        "fixed step ceiling is a runaway circuit breaker",
      ),
    };
  }

  return null;
}

function actionForStop(stop: TurnStop): Exclude<TurnPolicyAction["type"], "continue"> {
  if (stop.action === "synthesized") {
    return "synthesize";
  }
  return stop.action === "failed" ? "fail" : "pause";
}

export const TurnTerminationGate = {
  decide(obs: TurnPolicyObservation): TurnStop | null {
    return decideTermination(obs)?.stop ?? null;
  },
};

export function evaluateTurnTermination(obs: TurnPolicyObservation): TurnPolicyAction {
  const decision = decideTermination(obs);
  if (decision) {
    return {
      type: actionForStop(decision.stop),
      stop: decision.stop,
      debug: decision.debug,
    };
  }

  const analysis = analyzeTermination(obs);
  return {
    type: "continue",
    debug: withDebug("continue", analysis, "no stop condition selected"),
  };
}
