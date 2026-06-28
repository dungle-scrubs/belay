import type { Fields } from "../log";
import {
  buildProviderFailureLogFields,
  buildProviderFailureRecord,
  type ProviderFailureLogInput,
  type ProviderFailureRecord,
  type RecordFailureInput,
} from "./failure-record-schema";

export type {
  ProviderFailureLogInput,
  ProviderFailureRecord,
  RecordFailureInput,
} from "./failure-record-schema";

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

/**
 * The flat, greppable fields for a provider-failure log line (D-076 M6). Carries the classification,
 * retry decision, attempt, source/model, phase, and the stable fingerprint - plus the richer shape
 * metadata (status/code/shape field names) that is useful behind the verbose `provider` debug scope.
 * Every value is shape or a sanitized string; no secret can ride here.
 */
export function providerFailureLogFields(input: ProviderFailureLogInput): Fields {
  return buildProviderFailureLogFields(input);
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
    const record = buildProviderFailureRecord(input);
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
