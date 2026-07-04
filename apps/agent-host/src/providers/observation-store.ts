import type { ObservationInput } from "./failure-record-schema";
import {
  appendObservation,
  ensureMigrated,
  type ObservationIndex,
  readCorpusIndex,
} from "./observation-corpus";
import { type ObservationEnvelope, providerFailureEnvelope } from "./observation-envelope";

export type { ObservationInput } from "./failure-record-schema";
export { fingerprintObservation } from "./failure-record-schema";
export type { ObservationEnvelope } from "./observation-envelope";

/**
 * The producer-facing API of the redacted provider-failure observation corpus (plan 29, formerly the
 * D-076 single-file store). Unknown or low-confidence provider failure shapes are recorded here as
 * REDACTED, DEDUPED observations so the classifier's rules can be improved later without guessing. Only
 * the SHAPE of a failure is stored - provider, model, auth mode, phase, status/code, a sanitized
 * message skeleton, the top-level field NAMES of the raw error, the output-started flag, the classifier
 * verdict, the retry decision, and a stable fingerprint - never prompts, keys, auth headers, raw
 * response bodies, raw tool outputs, or raw provider payloads. Writes are best-effort: a failed write
 * never fails the user's turn.
 *
 * `/doctor` (M4) reads the deduped index to report counts and top fingerprints for unclassified
 * provider failures, again without exposing any secret.
 *
 * Responsible for: the narrow record/read/summarize API plus the one-time legacy migration seam.
 * Not for: filesystem mechanics (observation-corpus.ts), the envelope shape (observation-envelope.ts),
 * or fingerprinting (failure-record-schema.ts).
 *
 * NON-CONSUMPTION BOUNDARY (plan 29 D-003, enforced by observation-boundary.test.ts): the corpus is
 * diagnostic-only in this plan. Records written here are read back ONLY by `/doctor`, a debug export,
 * or an explicit inspect/export command - NEVER injected into a model prompt or the history
 * projection, and NEVER used to mutate a classifier rule at runtime. The classifier's rules stay
 * static; improving them from this evidence is a deliberate, OFFLINE/MANUAL workflow that a later plan
 * must authorize before any runtime consumer is wired.
 */

/**
 * Records one provider-failure observation, deduped by fingerprint. Best-effort: any failure is
 * swallowed (returns null) so a provider error never also fails the turn on a disk problem. Runs the
 * one-time legacy migration first so old single-file installs converge on the corpus path.
 */
export async function recordObservation(
  input: ObservationInput,
  nowIso: string,
): Promise<ObservationEnvelope | null> {
  await ensureMigrated();
  return appendObservation(providerFailureEnvelope(input, nowIso));
}

/** Reads the deduped observation index (best-effort), migrating any legacy single-file store first. */
export async function readObservations(): Promise<ObservationIndex> {
  await ensureMigrated();
  return readCorpusIndex();
}

/** A compact summary for `/doctor` / debug (M4): distinct shapes, total + unknown sightings, and the
 *  top fingerprints by count - no secrets, just shape ids. */
export interface ObservationSummary {
  readonly distinct: number;
  readonly total: number;
  readonly unknown: number;
  readonly top: readonly { readonly fingerprint: string; readonly count: number }[];
}

export function summarizeObservations(index: ObservationIndex): ObservationSummary {
  const records = Object.values(index);
  const total = records.reduce((sum, r) => sum + r.count, 0);
  const unknown = records
    .filter((r) => r.shape.classification === "unknown")
    .reduce((sum, r) => sum + r.count, 0);
  const top = [...records]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((r) => ({ fingerprint: r.fingerprint, count: r.count }));
  return { distinct: records.length, total, unknown, top };
}
