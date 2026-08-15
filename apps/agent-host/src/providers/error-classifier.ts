import { isContextOverflowText } from "@belay/session";
import { isContextOverflow as piAiIsContextOverflow } from "@earendil-works/pi-ai/compat";
import type { ProviderFailureClass } from "./failure-taxonomy";

/**
 * The provider error + overflow classification pi-ai.ts used to inline. It is the one place that
 * decides "is this a refused credential?", "is this LM Studio's context-length rejection?", "did
 * the finished response overflow the window?", and how the prompt-too-big message reads - so a
 * change to the auth signal, the overflow thresholds, or the too-big wording lands here once and
 * the prompt-too-big sites can't drift. Extracting it leaves pi-ai.ts a normalized adapter (map
 * pi-ai events -> host ProviderEvents) rather than a policy hub. The typed errors and log payloads
 * the adapter emits are unchanged - this only relocates the decision.
 *
 * Responsible for: provider error-text predicates - auth refusal, context overflow, retryability,
 * overflow-window parsing, and the prompt-too-big wording.
 * Not for: full taxonomy verdicts; classifyProviderFailure lives in failure-taxonomy.ts.
 */

/**
 * A provider stream error that means "the credential was refused", not "the backend is down" - an
 * expired/revoked/invalid API key or OAuth token. Classified from the error text (status 401/403,
 * "unauthorized", "invalid api key", "authentication", "expired") so a bad key surfaces as
 * ProviderAuthError ("auth failed - re-auth"), the actionable message, instead of a generic outage.
 */
const AUTH_ERROR =
  /\b401\b|\b403\b|unauthor|forbidden|invalid[\s_-]*(api[\s_-]*key|token|x-api-key)|authentication|api[\s_-]*key.*(invalid|expired|missing)|token.*expired|expired.*token/i;

/** True when a provider error text is a refused-credential failure (re-auth needed). */
export function isAuthFailure(detail: string): boolean {
  return AUTH_ERROR.test(detail);
}

/**
 * LM Studio rejects a prompt larger than the loaded window with a context-length 400. Its message
 * varies ("context length", "tokens to keep", "larger context", "context window"); match any so the
 * adapter can surface overflow (and recover) instead of swallowing it as an empty turn.
 */
/** True when a provider error text is LM Studio's context-length rejection. */
export function isContextOverflow(detail: string): boolean {
  return isContextOverflowText(detail);
}

/**
 * Classes Belay may auto-retry for the current step before any output has streamed. Every other
 * class - auth, overflow, quota, model/runtime unavailable, request rejected, unknown - is terminal
 * for the outage-retry path and surfaces its own actionable failure instead.
 */
const RETRYABLE_CLASSES: ReadonlySet<ProviderFailureClass> = new Set([
  "transient_transport",
  "rate_limited",
  "provider_overloaded",
  "provider_unavailable",
]);

/** Whether a normalized provider-failure class is eligible for bounded pre-output auto-retry. */
export function isRetryable(cls: ProviderFailureClass): boolean {
  return RETRYABLE_CLASSES.has(cls);
}

/**
 * The "prompt doesn't fit" overflow reason, built once so the pre-request estimate guard and LM
 * Studio's context-length 400 can't drift. LM Studio's own message omits the sizes, so we attach
 * our estimate + window.
 */
export function promptTooBig(promptTokensEst: number, contextWindow: number): string {
  return `the prompt (~${promptTokensEst} tokens) is too big for the ${contextWindow}-token context window`;
}

/**
 * Window-bearing overflow phrasings, most specific first. Each captures the CONTEXT-WINDOW token count
 * (group 1), never the prompt size: our own `promptTooBig` wording ("N-token context window") and the
 * common provider native forms ("maximum context length is N", "context window of N"). Beside
 * `promptTooBig` so the message it writes and the number read back out of it can't drift (03.2 M3 D-004).
 */
const OVERFLOW_WINDOW_PATTERNS: readonly RegExp[] = [
  /(\d[\d,]*)\s*-?\s*token context window/i,
  /maximum context (?:length|window)\s+(?:is\s+)?(\d[\d,]*)/i,
  /context (?:window|length)\s+of\s+(\d[\d,]*)/i,
];

/**
 * The real context window `N` an overflow message reveals, or null when it carries no window number
 * (a numberless "reduce the length", an auth error, etc.). The inverse of `promptTooBig`: lets a stale
 * bundled window self-heal from the provider's own rejection without trusting the size we sent.
 */
export function parseOverflowWindow(detail: string): number | null {
  for (const pattern of OVERFLOW_WINDOW_PATTERNS) {
    const match = pattern.exec(detail);
    if (match?.[1]) {
      const window = Number.parseInt(match[1].replace(/,/g, ""), 10);
      if (Number.isFinite(window) && window > 0) {
        return window;
      }
    }
  }
  return null;
}

/**
 * Classifies a COMPLETED model response as overflow or not. Overflow = the response was bounded by
 * the context window: a "length" stop that actually filled the window (so a model whose max-output
 * cap is below its window doesn't false-positive on long answers), or pi-ai's prompt-too-large /
 * provider-error variants (`isContextOverflow`). Returns the reason string, or null when the
 * response ended normally.
 */
export function classifyResponseOverflow(
  message: Parameters<typeof piAiIsContextOverflow>[0] | undefined,
  contextWindow: number,
): string | null {
  if (!message) {
    return null;
  }
  const usage = (message as { usage?: { input?: number; output?: number } }).usage;
  const used = (usage?.input ?? 0) + (usage?.output ?? 0);
  const hitWall =
    (message as { stopReason?: string }).stopReason === "length" && used >= contextWindow * 0.98;
  if (hitWall || piAiIsContextOverflow(message, contextWindow)) {
    return hitWall
      ? "hit the context window mid-response — output was truncated"
      : "the prompt exceeded the model's context window";
  }
  return null;
}
