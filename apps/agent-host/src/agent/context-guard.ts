/**
 * The larger->smaller context-fit guard for a mid-turn model switch (plan 09.1 M7, D-007). Switching
 * toward a SMALLER context window can overflow a conversation that grew under a larger one, so only that
 * direction is guarded; smaller->larger (or equal, or an unknown target) is always allowed. The decision
 * is pure - it compares the current conversation size plus reply headroom against the target model's
 * window - so the loop and the future auto-router share one rule. A non-fitting switch is REFUSED (v1):
 * the active provider is left unchanged and the refusal is recorded with a user-visible reason; reduce-
 * then-switch (compact, then retry) is a deferred enhancement.
 */

/** Tokens reserved for the model's reply on top of the carried conversation when checking fit. */
export const DEFAULT_REPLY_HEADROOM = 4096;

export interface SwitchFitInput {
  /** The current conversation/prompt size in tokens (the loop's latest measured input). */
  readonly conversationTokens: number;
  /** The current model's served context window (0 when not yet measured). */
  readonly currentWindow: number;
  /** The target model's context window (0/undefined when unknown - then the guard cannot fire). */
  readonly targetWindow: number;
  readonly replyHeadroom?: number;
}

export interface SwitchFitDecision {
  readonly fits: boolean;
  /** A user-visible reason, present only when the switch is refused. */
  readonly reason?: string;
}

export function fitsAfterSwitch(input: SwitchFitInput): SwitchFitDecision {
  const headroom = input.replyHeadroom ?? DEFAULT_REPLY_HEADROOM;
  // An unknown target window can't be guarded - allow it (the loop's overflow recovery still backstops).
  if (input.targetWindow <= 0) {
    return { fits: true };
  }
  // smaller->larger (or equal) never overflows: the conversation already fit the smaller current window.
  if (input.currentWindow > 0 && input.targetWindow >= input.currentWindow) {
    return { fits: true };
  }
  const needed = input.conversationTokens + headroom;
  if (needed <= input.targetWindow) {
    return { fits: true };
  }
  return {
    fits: false,
    reason: `the conversation (~${input.conversationTokens} tokens, plus ~${headroom} reserved for the reply) exceeds the target model's ${input.targetWindow}-token context window`,
  };
}
