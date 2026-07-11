/**
 * Translates a provider's raw usage-limit SIGNALS at the pi-ai boundary into a `limit` ProviderEvent
 * (plan 44.4). Two sources, one normalized output:
 *   - M2 (Claude, success path): the `anthropic-ratelimit-unified-*` response headers pi-ai surfaces
 *     via `onResponse`, parsed by the shared `@trevor/session` normalizer.
 *   - M3 (Codex/OpenAI, error path): a usage/rate/quota FAILURE the pi-ai stream throws, classified via
 *     the existing failure taxonomy into a "reached". pi-ai reduces the error to a message string (no
 *     headers/payload reach us), so resetsAt rides from a retry-after when one survived, else is
 *     recovered from the reset WORDING pi-ai bakes into the ChatGPT usage-limit sentence; detect-only
 *     when neither is present.
 *
 * One module so both providers' limit capture reads the SAME normalized vocabulary and the SAME
 * classification source, and so the boundary glue in pi-ai.ts stays thin.
 *
 * Responsible for: mapping provider limit signals (Claude headers, a classified failure) -> a `limit`
 * ProviderEvent, plus the inspected-keys helper for the detect-only gap log.
 * Not for: the pure header parse (@trevor/session/usage-limit), the classification rules
 * (failure-taxonomy.ts), or publishing the event (agent/turn.ts).
 */

import { msg } from "@host/transport/messages";
import { parseAnthropicUnifiedHeaders, unifiedHeaderKeys } from "@trevor/session";
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
 * A relative reset embedded in the provider's error PROSE, as unix epoch SECONDS. pi-ai's Codex HTTP
 * path builds "You have hit your ChatGPT usage limit (plan). Try again in ~42 min." - the structured
 * `resets_at` is collapsed into that sentence before it reaches us (and dropped entirely on the
 * streaming path), so the wording is the only reset signal left to recover. Deliberately narrow: a
 * single "try again in / resets in ~N unit" phrase, integer count, min/hour/second/day. `nowMs` is
 * injected so the delta->absolute conversion is deterministic.
 */
const RESET_PROSE =
  /(?:try again in|resets?(?: again)? in)\s*~?\s*(\d+)\s*(sec(?:ond)?|min(?:ute)?|hour|hr|day)s?/i;

function resetsAtFromMessage(detail: string, nowMs: number): number | undefined {
  const match = RESET_PROSE.exec(detail);
  const countRaw = match?.[1];
  const unitRaw = match?.[2];
  if (countRaw === undefined || unitRaw === undefined) {
    return undefined;
  }
  const count = Number(countRaw);
  if (!Number.isFinite(count) || count < 0) {
    return undefined;
  }
  const unit = unitRaw.toLowerCase();
  const secondsPerUnit = unit.startsWith("sec")
    ? 1
    : unit.startsWith("min")
      ? 60
      : unit.startsWith("hour") || unit === "hr"
        ? 3600
        : 86400; // day
  return Math.floor(nowMs / 1000) + count * secondsPerUnit;
}

/**
 * Maps a thrown provider-stream failure into a "reached" `limit` ProviderEvent when the failure taxonomy
 * classifies it as a usage cap or hard stop (`usage_limit`, `rate_limited`, or `quota_billing` - a Codex
 * usage-limit / 429, or any provider's hard usage/rate stop); null otherwise. `scope` is `unknown` (the
 * error path exposes no window). `resetsAt` (unix epoch SECONDS) is derived from a retry-after DELTA when
 * the provider supplied one, else recovered from the reset WORDING in the message (the Codex path carries
 * the reset only as prose - see {@link resetsAtFromMessage}); detect-only when neither is present. `nowMs`
 * is injected so the delta->absolute conversion is deterministic. The taxonomy stays the single source.
 */
export function failureLimitEvent(
  cause: unknown,
  provider: string,
  nowMs: number = Date.now(),
): LimitEvent | null {
  const detail = msg(cause);
  const evidence = extractFailureEvidence(cause);
  const failure = classifyProviderFailure({
    provider,
    detail,
    status: evidence.status,
    code: evidence.code,
    retryAfterMs: evidence.retryAfterMs,
  });
  if (
    failure.class !== "usage_limit" &&
    failure.class !== "rate_limited" &&
    failure.class !== "quota_billing"
  ) {
    return null;
  }
  const resetsAt =
    failure.retryAfterMs !== undefined
      ? Math.floor(nowMs / 1000) + Math.round(failure.retryAfterMs / 1000)
      : resetsAtFromMessage(detail, nowMs);
  return {
    type: "limit",
    status: "reached",
    scope: "unknown",
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}
