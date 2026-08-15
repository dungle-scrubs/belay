/**
 * Translates a provider's raw usage-limit SIGNALS at the pi-ai boundary into a `limit` ProviderEvent
 * (plan 44.4). Two sources, one normalized output:
 *   - M2 (Claude, success path): the `anthropic-ratelimit-unified-*` response headers pi-ai surfaces
 *     via `onResponse`, parsed by the shared `@belay/session` normalizer.
 *   - M3 (Codex/OpenAI, error path): a rate/quota FAILURE the pi-ai stream throws, classified via the
 *     existing failure taxonomy into a detect-only "reached" (pi-ai strips the APIError to a message
 *     string, so no headers reach us - resetsAt rides only when a retry-after was present).
 *
 * One module so both providers' limit capture reads the SAME normalized vocabulary and the SAME
 * classification source, and so the boundary glue in pi-ai.ts stays thin.
 *
 * Responsible for: mapping provider limit signals (Claude headers, a classified failure) -> a `limit`
 * ProviderEvent, plus the inspected-keys helper for the detect-only gap log.
 * Not for: the pure header parse (@belay/session/usage-limit), the classification rules
 * (failure-taxonomy.ts), or publishing the event (agent/turn.ts).
 */

import { parseAnthropicUnifiedHeaders, unifiedHeaderKeys } from "@belay/session";
import { msg } from "@host/transport/messages";
import { extractFailureEvidence } from "./failure-evidence";
import { classifyProviderFailure } from "./failure-taxonomy";
import type { ProviderEvent } from "./types";

/** The `limit` member of ProviderEvent - the one shape both capture paths produce. */
export type LimitEvent = Extract<ProviderEvent, { type: "limit" }>;

/** Re-export so pi-ai.ts logs the inspected unified keys through one import when the parse is empty. */
export { unifiedHeaderKeys };

/**
 * Maps Claude's `anthropic-ratelimit-unified-*` response headers into a `limit` ProviderEvent, or null
 * when the response carried no unified rate-limit headers (not the Claude path) OR the status is the
 * steady-state `ok` (`allowed`) that rides EVERY successful response. Only `approaching`/`reached` are
 * noteworthy - surfacing "ok" would put an "all good" limit marker on every Claude turn, unlike every
 * sibling marker (which fires only on a notable transition). Pure - defers the parse to the shared
 * normalizer; this reshapes its `UsageLimit` (already optional-omitting) into the ProviderEvent variant.
 */
export function anthropicLimitEvent(headers: Record<string, string>): LimitEvent | null {
  const limit = parseAnthropicUnifiedHeaders(headers);
  if (!limit || limit.status === "ok") {
    return null;
  }
  return { type: "limit", ...limit };
}

/**
 * Maps a thrown provider-stream failure into a detect-only "reached" `limit` ProviderEvent when the
 * failure taxonomy classifies it as `rate_limited` or `quota_billing` (a Codex 429 / usageLimitExceeded,
 * or any provider's hard usage/rate stop); null otherwise. `scope` is `unknown` (the error path exposes
 * no window). `resetsAt` (unix epoch SECONDS) is derived from a retry-after DELTA only when the provider
 * supplied one - usually stripped on the pi-ai error path, so typically detect-only. `nowMs` is injected
 * so the delta->absolute conversion is deterministic. The taxonomy stays the single classification source.
 */
export function failureLimitEvent(
  cause: unknown,
  provider: string,
  nowMs: number = Date.now(),
): LimitEvent | null {
  const evidence = extractFailureEvidence(cause);
  const failure = classifyProviderFailure({
    provider,
    detail: msg(cause),
    status: evidence.status,
    code: evidence.code,
    retryAfterMs: evidence.retryAfterMs,
  });
  if (failure.class !== "rate_limited" && failure.class !== "quota_billing") {
    return null;
  }
  const resetsAt =
    failure.retryAfterMs !== undefined
      ? Math.floor(nowMs / 1000) + Math.round(failure.retryAfterMs / 1000)
      : undefined;
  return {
    type: "limit",
    status: "reached",
    scope: "unknown",
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}
