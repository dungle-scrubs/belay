import { isContextOverflow } from "@earendil-works/pi-ai/compat";

/**
 * The provider error + overflow classification pi-ai.ts used to inline. It is the one place that
 * decides "is this a refused credential?", "is this LM Studio's context-length rejection?", "did
 * the finished response overflow the window?", and how the prompt-too-big message reads - so a
 * change to the auth signal, the overflow thresholds, or the too-big wording lands here once and
 * the prompt-too-big sites can't drift. Extracting it leaves pi-ai.ts a normalized adapter (map
 * pi-ai events -> host ProviderEvents) rather than a policy hub. The typed errors and log payloads
 * the adapter emits are unchanged - this only relocates the decision.
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
export function isAuthError(detail: string): boolean {
  return AUTH_ERROR.test(detail);
}

/**
 * LM Studio rejects a prompt larger than the loaded window with a context-length 400. Its message
 * varies ("context length", "tokens to keep", "larger context", "context window"); match any so the
 * adapter can surface overflow (and recover) instead of swallowing it as an empty turn.
 */
const CONTEXT_LENGTH_ERROR = /context length|tokens to keep|larger context|context window/i;

/** True when a provider error text is LM Studio's context-length rejection. */
export function isContextLengthError(detail: string): boolean {
  return CONTEXT_LENGTH_ERROR.test(detail);
}

/**
 * A TRANSIENT transport fault the agent loop may auto-retry (D-076…D-078): a dropped WebSocket
 * (the Codex transport), a reset/closed connection, a timeout, or an HTTP 429/5xx. Matched from the
 * error text. Auth failures and context overflow are NOT here - they keep their own dedicated
 * handling (re-auth message / overflow recovery); every other outage stays terminal. This is the one
 * place the retryable verdict lives; the loop reads the boolean off `ProviderUnavailable.retryable`.
 */
const RETRYABLE_OUTAGE =
  /websocket|\bws\b|socket hang ?up|\b1006\b|econnreset|econnrefused|epipe|etimedout|enetunreach|enotfound|connection (reset|closed|refused|aborted|error)|reset by peer|timed? ?out|\b429\b|\b50[0234]\b|service unavailable|bad gateway|gateway time ?out|temporarily unavailable|stream (closed|interrupted|aborted unexpectedly)|premature close|aborted unexpectedly/i;

/** True when a provider outage is a transient transport fault worth a bounded auto-retry. */
export function isRetryableOutage(detail: string): boolean {
  return RETRYABLE_OUTAGE.test(detail);
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
 * Classifies a COMPLETED model response as overflow or not. Overflow = the response was bounded by
 * the context window: a "length" stop that actually filled the window (so a model whose max-output
 * cap is below its window doesn't false-positive on long answers), or pi-ai's prompt-too-large /
 * provider-error variants (`isContextOverflow`). Returns the reason string, or null when the
 * response ended normally.
 */
export function classifyResponseOverflow(
  message: Parameters<typeof isContextOverflow>[0] | undefined,
  contextWindow: number,
): string | null {
  if (!message) {
    return null;
  }
  const usage = (message as { usage?: { input?: number; output?: number } }).usage;
  const used = (usage?.input ?? 0) + (usage?.output ?? 0);
  const hitWall =
    (message as { stopReason?: string }).stopReason === "length" && used >= contextWindow * 0.98;
  if (hitWall || isContextOverflow(message, contextWindow)) {
    return hitWall
      ? "hit the context window mid-response — output was truncated"
      : "the prompt exceeded the model's context window";
  }
  return null;
}
