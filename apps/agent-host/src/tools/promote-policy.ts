import { classifyAlwaysPreventedBashCommand } from "./bash-safety";

/**
 * The promotion policy (plan 09 M1): the pure decision for what happens to a shell command that the
 * caller (the `bash` tool or the prompt-shell lane) is about to run or has been running. It decides
 * between four outcomes and is kept SEPARATE from any child-process spawning - the runner consults this
 * to know whether to detach a still-running command into a tracked background job (`pN`) instead of
 * timing it out.
 *
 *   - `refuse`   - the command trips the SAME always-prevented safety floor as bash/process; it never
 *                  runs, let alone promotes.
 *   - `complete` - it finished within the threshold (a normal foreground result).
 *   - `fail`     - it finished non-zero, OR it crossed the threshold but promotion is disabled (so it is
 *                  a plain timeout, not a background job).
 *   - `promote`  - it is still running past the threshold and promotion is enabled: detach it into a
 *                  background job and hand back its id.
 */
export type PromotionDecision = "refuse" | "complete" | "fail" | "promote";

/** The observed lifecycle point the policy is deciding at. */
export type CommandOutcome = "completed" | "failed" | "running-at-threshold";

export interface PromotionInput {
  readonly command: string;
  /** The directory the command runs in - the safety floor is workspace-relative. */
  readonly cwd: string;
  /** Whether background-job promotion is enabled (host/user config). When off, a long command times out
   *  exactly as before instead of detaching. */
  readonly enabled: boolean;
  /** The threshold in ms past which a still-running command is promoted rather than timed out. */
  readonly thresholdMs: number;
  readonly outcome: CommandOutcome;
}

export interface PromotionResult {
  readonly decision: PromotionDecision;
  /** A short human reason, surfaced in the tool result + the job metadata. */
  readonly reason: string;
}

/** The runtime promotion config the bash tool + prompt-shell lane consult. */
export interface PromotionConfig {
  readonly enabled: boolean;
  readonly thresholdMs: number;
}

/** Promotion ON with the threshold at the legacy foreground timeout (30s): a command that would have
 *  timed out is promoted into a tracked background job instead of failing. */
export const DEFAULT_PROMOTION_CONFIG: PromotionConfig = { enabled: true, thresholdMs: 30_000 };

/**
 * Decides a command's promotion outcome. Safety is checked FIRST and unconditionally (a refused command
 * can never reach a background job), then the observed outcome resolves complete/fail, and only a command
 * still running at the threshold with promotion enabled becomes a job.
 */
export function decidePromotion(input: PromotionInput): PromotionResult {
  const blocked = classifyAlwaysPreventedBashCommand(input.command, { workspaceRoot: input.cwd });
  if (blocked) {
    return { decision: "refuse", reason: blocked };
  }
  if (input.outcome === "completed") {
    return { decision: "complete", reason: "finished within the threshold" };
  }
  if (input.outcome === "failed") {
    return { decision: "fail", reason: "command failed" };
  }
  if (!input.enabled) {
    return {
      decision: "fail",
      reason: "still running at the threshold; promotion disabled (timed out)",
    };
  }
  return {
    decision: "promote",
    reason: `still running past ${input.thresholdMs}ms - promoted to a background job`,
  };
}
