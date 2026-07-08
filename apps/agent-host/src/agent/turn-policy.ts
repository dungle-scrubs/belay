import type { TurnStop } from "@trevor/session";

/**
 * Pure adaptive turn-termination policy.
 *
 * The evaluator separates two axes that used to be collapsed into one step count:
 * context pressure (how full the model window is) and loop health (whether the
 * tool loop is still making progress). The fixed step ceiling remains a high
 * circuit breaker; at low context it pauses with diagnostics instead of posing
 * as a normal answer.
 *
 * Responsible for: the pure turn-termination gate - evaluating step, context-pressure, and
 * loop-health observations into the turn's stop/continue decision.
 * Not for: deriving the step budget itself - turn-budget.ts.
 */

export interface TurnPolicyObservation {
  readonly steps: number;
  /** The effective step budget for this evaluation - the active CHECKPOINT threshold. The loop derives
   *  it adaptively (see turn-budget.ts) and composes the accumulated checkpoint grant into it; the gate
   *  only compares `steps` against it and never derives it itself (D-019). */
  readonly maxSteps: number;
  readonly inputTokens: number;
  readonly contextWindow: number;
  readonly contextBudgetFraction: number;
  readonly repeatedToolName?: string;
  readonly repeatedToolRounds: number;
  /** Optional one-line reason from the budget derivation, used only to enrich the step-backstop
   *  summary; the gate stays ignorant of how the budget was computed (D-019, D-025). */
  readonly budgetReason?: string;
  /** The absolute runaway ceiling on the step axis (02.17 D-004). When supplied, reaching `maxSteps`
   *  below this ceiling is a CHECKPOINT (auto-continue), not a pause; the turn terminates on the step
   *  axis only at this ceiling. Absent => the legacy single-axis backstop (reaching `maxSteps` pauses),
   *  so existing direct-gate callers/tests are unchanged. */
  readonly emergencyMaxSteps?: number;
  /** Whether context advanced by a non-trivial amount over the last checkpoint window (02.17 D-003).
   *  The progress guard: auto-continue requires it. Defaults to true when absent (the loop always
   *  provides the real signal). A diverse-no-op-tool turn that the same-tool stall detector misses
   *  trips this guard and pauses instead of running to the ceiling. */
  readonly contextAdvanced?: boolean;
  readonly providerDiagnostic?: {
    readonly reason: string;
    readonly retryable: boolean;
    readonly phase: string;
  };
}

export type TurnPolicyAction =
  | { readonly type: "continue"; readonly debug: TurnPolicyDebug }
  /** A step checkpoint: the adaptive budget is met with headroom + progress below the ceiling, so the
   *  loop auto-continues and emits a quiet breadcrumb instead of pausing (02.17 D-001). */
  | { readonly type: "checkpoint"; readonly debug: TurnPolicyDebug }
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
  /** A terminating stop, or null for a non-terminating step checkpoint (auto-continue). */
  readonly stop: TurnStop | null;
  /** True when `stop` is null because the step axis hit a checkpoint (the loop continues + breadcrumbs). */
  readonly checkpoint: boolean;
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

/** Builds the `loop_stalled` summary: a short description of the repeated-call stall followed by a
 *  tool-aware HINT the model sees on resume, so it does not repeat the same identical-argument cycle.
 *  The detector fires on a byte-identical `name:arguments` signature, so the hint names that and calls
 *  out the most common trap - a long-lived `process` job (dev server, watcher, build) that never exits
 *  on its own, which a model can spin on polling forever. Pure and exported so the wording is unit-tested. */
export function loopStalledSummary(
  repeatedToolName: string | undefined,
  repeatedToolRounds: number,
): string {
  const subject = repeatedToolName ? `${repeatedToolName} tool` : "tool";
  const hint =
    repeatedToolName === "process"
      ? ` A \`process\` job (dev server, watcher, build) does not exit on its own, so polling it cannot make progress - read its output once and continue, or \`kill\` it.`
      : ` Each round reused identical arguments. Vary the arguments, switch tools, or give your final answer instead of repeating the same call.`;
  return `Paused after ${repeatedToolRounds} repeated ${subject} rounds without enough progress.${hint}`;
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

function stopDecision(stop: TurnStop, debug: TurnPolicyDebug): TurnTerminationDecision {
  return { stop, checkpoint: false, debug };
}

function decideTermination(obs: TurnPolicyObservation): TurnTerminationDecision | null {
  const analysis = analyzeTermination(obs);
  if (obs.providerDiagnostic) {
    return stopDecision(
      {
        cause: "provider_protocol_anomaly",
        action: obs.providerDiagnostic.retryable ? "paused" : "failed",
        summary: `Provider protocol anomaly during ${obs.providerDiagnostic.phase}: ${obs.providerDiagnostic.reason}`,
        steps: obs.steps,
        ...(analysis.context ? { context: analysis.context } : {}),
      },
      withDebug(
        "provider_protocol_anomaly",
        analysis,
        "provider diagnostics outrank budget explanations",
      ),
    );
  }

  if (analysis.overContext) {
    return stopDecision(
      {
        cause: "context_pressure",
        action: "synthesized",
        summary: `Context pressure reached ${(analysis.pressure * 100).toFixed(1)}%; synthesizing before opening more tools.`,
        steps: obs.steps,
        ...(analysis.context ? { context: analysis.context } : {}),
      },
      withDebug("context_pressure", analysis, "context pressure outranks the raw step backstop"),
    );
  }

  if (analysis.stalled) {
    return stopDecision(
      {
        cause: "loop_stalled",
        action: "paused",
        summary: loopStalledSummary(obs.repeatedToolName, obs.repeatedToolRounds),
        steps: obs.steps,
        ...(analysis.context ? { context: analysis.context } : {}),
      },
      withDebug("loop_stalled", analysis, "repeated tool rounds beat raw step count"),
    );
  }

  if (analysis.overSteps) {
    // Legacy single-axis backstop when no emergency ceiling is supplied (older direct-gate callers /
    // tests): the adaptive budget is the runaway circuit breaker and reaching it pauses, unchanged.
    if (obs.emergencyMaxSteps === undefined) {
      return stopDecision(
        {
          cause: "step_backstop",
          action: "paused",
          summary: obs.budgetReason
            ? `Paused at the adaptive ${obs.maxSteps}-step budget before context pressure (${obs.budgetReason}).`
            : `Paused at the ${obs.maxSteps}-step backstop before context pressure.`,
          steps: obs.steps,
          ...(analysis.context ? { context: analysis.context } : {}),
        },
        withDebug("step_backstop", analysis, "adaptive step budget is a runaway circuit breaker"),
      );
    }

    // Checkpoint logic (02.17). By the time execution reaches the step axis, headroom (context_pressure)
    // and no-stall (loop_stalled) are already guaranteed - they were evaluated and rejected ABOVE this
    // branch by the priority ordering (D-002) - so auto-continue needs NO second pressure/stall gate.
    // The only gates are the absolute emergency ceiling (the runaway guard) and the progress guard.
    const atCeiling = obs.steps >= obs.emergencyMaxSteps;
    const progressed = obs.contextAdvanced !== false;
    if (!atCeiling && progressed) {
      return {
        stop: null,
        checkpoint: true,
        debug: withDebug(
          "step_checkpoint",
          analysis,
          "adaptive budget reached with headroom and progress: auto-continue, not pause",
        ),
      };
    }
    // Terminate on the step axis: at/over the emergency ceiling (runaway), or the progress guard failed
    // (context went flat across the checkpoint window - a diverse-no-op-tool loop the stall detector misses).
    const summary = atCeiling
      ? `Paused at the ${obs.emergencyMaxSteps}-step emergency ceiling (runaway guard).`
      : `Paused at step ${obs.steps}: context stopped advancing across the step-budget checkpoint${obs.budgetReason ? ` (${obs.budgetReason})` : ""}.`;
    return stopDecision(
      {
        cause: "step_backstop",
        action: "paused",
        summary,
        steps: obs.steps,
        ...(analysis.context ? { context: analysis.context } : {}),
      },
      withDebug(
        "step_backstop",
        analysis,
        atCeiling ? "emergency ceiling reached" : "progress guard failed",
      ),
    );
  }

  return null;
}

function actionForStop(stop: TurnStop): Exclude<TurnPolicyAction["type"], "continue"> {
  if (stop.action === "synthesized") {
    return "synthesize";
  }
  return stop.action === "failed" ? "fail" : "pause";
}

/** The step-axis assessment the loop reads: a terminating stop, OR a checkpoint (auto-continue), OR
 *  neither (run the next step). A checkpoint carries no `TurnStop` - emission + the accumulated grant
 *  are the loop's job, so the gate stays a pure decision (D-007). */
export interface TurnAssessment {
  readonly stop: TurnStop | null;
  readonly checkpoint: boolean;
}

export const TurnTerminationGate = {
  decide(obs: TurnPolicyObservation): TurnStop | null {
    return decideTermination(obs)?.stop ?? null;
  },
  assess(obs: TurnPolicyObservation): TurnAssessment {
    const decision = decideTermination(obs);
    return { stop: decision?.stop ?? null, checkpoint: decision?.checkpoint ?? false };
  },
};

export function evaluateTurnTermination(obs: TurnPolicyObservation): TurnPolicyAction {
  const decision = decideTermination(obs);
  if (decision?.checkpoint) {
    return { type: "checkpoint", debug: decision.debug };
  }
  if (decision?.stop) {
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
