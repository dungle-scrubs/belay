import { isDisallowedTelemetryKey, redactAttributeValue } from "./telemetry-contract";

/**
 * The shared Sentry PRIVACY contract (plan 13 M9/M10). This is a pure, SDK-free module: it defines what a
 * Sentry error event may carry and scrubs everything else, so the actual `Sentry.init` (app-owned, D-003)
 * only has to pass {@link scrubSentryEvent} as its `beforeSend`. Nothing here imports `@sentry/*`.
 *
 * Sentry is ERROR-ONLY and opt-in (D-002): a DSN must be present, and it is force-off under test/CI. Even
 * then, prompt text, transcript bodies, tool/command output, env values, auth headers, API keys, raw
 * provider bodies, and raw paths must never reach Sentry - so `beforeSend` drops request headers + bodies
 * outright, strips sensitive/high-cardinality keys from `extra`/`tags`/`contexts`, and secret-redacts the
 * message + breadcrumb text. An event that cannot be made safe is dropped (return null).
 */

/** The subset of a Sentry event this scrubber sanitizes (structural, so no SDK type dependency). */
export interface SanitizableSentryEvent {
  message?: string;
  extra?: Record<string, unknown>;
  tags?: Record<string, string | undefined>;
  contexts?: Record<string, Record<string, unknown> | undefined>;
  breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
  request?: { url?: string; headers?: Record<string, string>; cookies?: string; data?: unknown };
  exception?: {
    values?: Array<{ type?: string; value?: string }>;
  };
}

/** Filters a string-keyed record to the allowed keys, secret-redacting each surviving string value. */
function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isDisallowedTelemetryKey(key) || value === undefined || value === null) {
      continue;
    }
    safe[key] =
      typeof value === "number" || typeof value === "boolean" ? value : redactAttributeValue(value);
  }
  return safe;
}

/**
 * `beforeSend`: sanitizes a Sentry error event in place-ish (returns a scrubbed copy). Drops the whole
 * request headers/cookies/body (auth + payloads), strips disallowed keys from extra/tags/contexts,
 * secret-redacts the message + each exception value + each breadcrumb. Returns the scrubbed event.
 */
export function scrubSentryEvent<E extends SanitizableSentryEvent>(event: E): E {
  const scrubbed: SanitizableSentryEvent = { ...event };
  if (scrubbed.message !== undefined) {
    scrubbed.message = redactAttributeValue(scrubbed.message);
  }
  if (scrubbed.extra) {
    scrubbed.extra = sanitizeRecord(scrubbed.extra);
  }
  if (scrubbed.tags) {
    scrubbed.tags = sanitizeRecord(scrubbed.tags) as Record<string, string>;
  }
  if (scrubbed.contexts) {
    const contexts: Record<string, Record<string, unknown>> = {};
    for (const [name, ctx] of Object.entries(scrubbed.contexts)) {
      if (ctx) {
        contexts[name] = sanitizeRecord(ctx);
      }
    }
    scrubbed.contexts = contexts;
  }
  if (scrubbed.breadcrumbs) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map((crumb) => ({
      ...crumb,
      ...(crumb.message !== undefined ? { message: redactAttributeValue(crumb.message) } : {}),
      ...(crumb.data ? { data: sanitizeRecord(crumb.data) } : {}),
    }));
  }
  if (scrubbed.exception?.values) {
    scrubbed.exception = {
      values: scrubbed.exception.values.map((v) => ({
        ...v,
        ...(v.value !== undefined ? { value: redactAttributeValue(v.value) } : {}),
      })),
    };
  }
  // The request carries a URL + auth headers + the raw body - none of it is safe, so drop it entirely.
  scrubbed.request = undefined;
  return scrubbed as E;
}
