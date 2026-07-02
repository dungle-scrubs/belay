import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveTrevorStateHome } from "@trevor/session/node-paths";
import {
  buildObservation,
  mergeObservation,
  type ObservationInput,
  type ProviderObservation,
} from "./failure-record-schema";

export {
  buildObservation,
  type FingerprintParts,
  failureFingerprint,
  fingerprintObservation,
  type ObservationInput,
  type ProviderObservation,
} from "./failure-record-schema";

/**
 * The redacted provider-failure observation store (D-076 M5). Unknown or low-confidence provider
 * failure shapes are recorded here as REDACTED, DEDUPED observations so the classifier's rules can be
 * improved later without guessing. It deliberately stores only the SHAPE of a failure - provider,
 * model, auth mode, phase, status/code, a sanitized message skeleton, the top-level field NAMES of
 * the raw error, the output-started flag, the classifier verdict, the retry decision, and a stable
 * fingerprint - never prompts, keys, auth headers, raw response bodies, raw tool outputs, or raw
 * provider payloads. Writes are best-effort: a failed write never fails the user's turn.
 *
 * `/doctor` (M6) reads the deduped records to report counts and fingerprints for unclassified
 * provider failures, again without exposing any secret.
 *
 * Responsible for: persisting deduped, redacted failure observations to disk and summarizing them.
 * Not for: the record shapes and fingerprints themselves; those live in failure-record-schema.ts.
 */

/** The JSON file backing the store: `<TREVOR_STATE_HOME>/provider-observations.json`. */
export function observationsPath(): string {
  return join(resolveTrevorStateHome(), "provider-observations.json");
}

/** Reads all observations (best-effort): a missing or unreadable/corrupt file yields an empty map. */
export async function readObservations(): Promise<Record<string, ProviderObservation>> {
  try {
    const raw = await readFile(observationsPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, ProviderObservation>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Records one observation, deduped by fingerprint. Best-effort: any read/write/serialize failure is
 * swallowed so a provider error never also fails the turn on a disk problem. Returns the resulting
 * record (or null when the write failed) for tests and callers that want to assert.
 */
export async function recordObservation(
  input: ObservationInput,
  nowIso: string,
): Promise<ProviderObservation | null> {
  try {
    const store = await readObservations();
    const fresh = buildObservation(input, nowIso);
    const prior = store[fresh.fingerprint];
    const merged = prior ? mergeObservation(prior, fresh) : fresh;
    store[fresh.fingerprint] = merged;
    const path = observationsPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    return merged;
  } catch {
    return null;
  }
}

/** A compact summary for `/doctor` / debug (M6): how many distinct unclassified shapes, total
 *  sightings, and the top fingerprints by count - no secrets, just shape ids. */
export interface ObservationSummary {
  readonly distinct: number;
  readonly total: number;
  readonly unknown: number;
  readonly top: readonly { readonly fingerprint: string; readonly count: number }[];
}

export function summarizeObservations(
  store: Record<string, ProviderObservation>,
): ObservationSummary {
  const records = Object.values(store);
  const total = records.reduce((sum, r) => sum + r.count, 0);
  const unknown = records
    .filter((r) => r.classification === "unknown")
    .reduce((sum, r) => sum + r.count, 0);
  const top = [...records]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((r) => ({ fingerprint: r.fingerprint, count: r.count }));
  return { distinct: records.length, total, unknown, top };
}
