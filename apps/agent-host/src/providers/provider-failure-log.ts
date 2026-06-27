import type { Fields } from "../log";
import type { ProviderFailureClass, ProviderUserAction } from "./failure-taxonomy";
import { redactSecrets } from "./failure-taxonomy";
import { failureFingerprint } from "./observation-store";

/**
 * The host's recent-provider-failure diagnostics (D-076 M6). Two jobs, one cohesive module:
 *
 * 1. {@link providerFailureLogFields} builds the SANITIZED structured fields a boundary logs for a
 *    failure - classification, retry decision, attempt number, source/model, phase, and a stable
 *    fingerprint - so every log line for the same shape correlates and never carries a secret.
 * 2. {@link ProviderFailureLog} (the `providerFailures` singleton) keeps the last N terminal failures
 *    in memory, tagged retry-exhausted vs non-retryable-terminal, so `/doctor` can report the two
 *    SEPARATELY (a transient outage that gave up reads differently from an auth/quota/rejected
 *    failure that was never eligible for retry).
 *
 * In-memory and best-effort: it informs diagnostics, it never gates a turn. Counts and fingerprints
 * only - no prompt, key, token, or raw payload ever lands here.
 */

/** The inputs to a structured failure log line (already-redacted detail in, sanitized fields out). */
export interface ProviderFailureLogInput {
  readonly provider: string;
  readonly model: string;
  readonly phase: string;
  readonly classification?: ProviderFailureClass;
  readonly retryable: boolean;
  readonly userAction?: ProviderUserAction;
  /** The reconnect attempt this line is about (0 = the initial attempt / a terminal with no retries). */
  readonly attempt: number;
  /** Whether this line is a between-retries reconnect or the terminal outcome. */
  readonly outcome: "reconnect" | "terminal";
  readonly status?: number;
  readonly code?: string;
  readonly shapeFields?: readonly string[];
  /** A human detail; re-redacted defensively so a caller that forgot to sanitize still can't leak. */
  readonly detail: string;
}

/**
 * The flat, greppable fields for a provider-failure log line (D-076 M6). Carries the classification,
 * retry decision, attempt, source/model, phase, and the stable fingerprint - plus the richer shape
 * metadata (status/code/shape field names) that is useful behind the verbose `provider` debug scope.
 * Every value is shape or a sanitized string; no secret can ride here.
 */
export function providerFailureLogFields(input: ProviderFailureLogInput): Fields {
  const classification = input.classification ?? "unknown";
  return {
    provider: input.provider,
    model: input.model,
    phase: input.phase,
    class: classification,
    retryable: input.retryable,
    action: input.userAction,
    attempt: input.attempt,
    outcome: input.outcome,
    status: input.status,
    code: input.code,
    shapeFields: input.shapeFields?.length ? input.shapeFields.join(",") : undefined,
    fingerprint: failureFingerprint({
      provider: input.provider,
      classification,
      status: input.status,
      code: input.code,
      shapeFields: input.shapeFields,
      message: input.detail,
    }),
    detail: redactSecrets(input.detail),
  };
}

/** One recorded terminal provider failure (the recent-failures ring; counts/fingerprints only). */
export interface ProviderFailureRecord {
  readonly provider: string;
  readonly model: string;
  readonly classification?: ProviderFailureClass;
  readonly userAction?: ProviderUserAction;
  /** True when the loop exhausted its bounded reconnect budget (a transient outage that gave up);
   *  false when the failure was a non-retryable terminal one (auth, quota, rejected, …). */
  readonly retryExhausted: boolean;
  /** How many reconnect attempts were made before going terminal (0 when never retryable). */
  readonly attempts: number;
  readonly fingerprint: string;
  /** A sanitized one-line detail (re-redacted on record). */
  readonly detail: string;
  readonly at: string;
}

/** The redaction-safe summary `/doctor` reads: the two terminal categories, kept distinct. */
export interface ProviderFailureSummary {
  /** Recent failures that exhausted the bounded retry budget (a transient outage that gave up). */
  readonly retryExhausted: number;
  /** Recent terminal failures that were never eligible for retry (auth, quota, rejected, …). */
  readonly nonRetryableTerminal: number;
  /** The most recent of each category, for an at-a-glance finding message. */
  readonly lastRetryExhausted?: ProviderFailureRecord;
  readonly lastTerminal?: ProviderFailureRecord;
}

/** Summarizes a set of recorded failures into the two distinct terminal categories (pure). */
export function summarizeFailures(
  records: readonly ProviderFailureRecord[],
): ProviderFailureSummary {
  let retryExhausted = 0;
  let nonRetryableTerminal = 0;
  let lastRetryExhausted: ProviderFailureRecord | undefined;
  let lastTerminal: ProviderFailureRecord | undefined;
  for (const record of records) {
    if (record.retryExhausted) {
      retryExhausted += 1;
      lastRetryExhausted = record;
    } else {
      nonRetryableTerminal += 1;
      lastTerminal = record;
    }
  }
  return { retryExhausted, nonRetryableTerminal, lastRetryExhausted, lastTerminal };
}

/** The inputs the turn consumer records on a terminal provider failure (detail re-redacted here). */
export interface RecordFailureInput {
  readonly provider: string;
  readonly model: string;
  readonly classification?: ProviderFailureClass;
  readonly userAction?: ProviderUserAction;
  readonly retryExhausted: boolean;
  readonly attempts: number;
  readonly status?: number;
  readonly code?: string;
  readonly shapeFields?: readonly string[];
  readonly detail: string;
  readonly at: string;
}

/** Recent terminal provider failures, capped so the ring can't grow unbounded. */
const MAX_RECORDS = 50;

/**
 * The in-memory recent-failures ring. A module singleton (`providerFailures`) so the turn consumer
 * that records and the `/doctor` command that reads share one instance in the host process. Bounded
 * and resettable (tests).
 */
export class ProviderFailureLog {
  private records: ProviderFailureRecord[] = [];

  record(input: RecordFailureInput): ProviderFailureRecord {
    const record: ProviderFailureRecord = {
      provider: input.provider,
      model: input.model,
      classification: input.classification,
      userAction: input.userAction,
      retryExhausted: input.retryExhausted,
      attempts: input.attempts,
      fingerprint: failureFingerprint({
        provider: input.provider,
        classification: input.classification ?? "unknown",
        status: input.status,
        code: input.code,
        shapeFields: input.shapeFields,
        message: input.detail,
      }),
      detail: redactSecrets(input.detail),
      at: input.at,
    };
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      this.records.splice(0, this.records.length - MAX_RECORDS);
    }
    return record;
  }

  list(): readonly ProviderFailureRecord[] {
    return [...this.records];
  }

  summary(): ProviderFailureSummary {
    return summarizeFailures(this.records);
  }

  reset(): void {
    this.records = [];
  }
}

/** The host-process-wide recent-failures ring (shared by the turn consumer and `/doctor`). */
export const providerFailures = new ProviderFailureLog();
