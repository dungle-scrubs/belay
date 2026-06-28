import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveTrevorStateHome } from "@trevor/session/node-paths";
import type { ProviderFailureClass } from "./failure-taxonomy";
import { redactSecrets } from "./failure-taxonomy";

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
 */

/** The inputs needed to record one observation; the store derives the fingerprint, dedupes, and
 *  re-redacts the message defensively before persisting. */
export interface ObservationInput {
  readonly provider: string;
  readonly model?: string;
  /** "oauth" | "api-key" | "none" | "unknown" - the auth strategy, NOT any credential. */
  readonly authMode?: string;
  /** Where in the turn the failure surfaced, e.g. "model-step". */
  readonly phase: string;
  readonly classification: ProviderFailureClass;
  readonly retryable: boolean;
  readonly status?: number;
  readonly code?: string;
  /** A human message; redacted again here so a caller that forgot to sanitize still can't leak. */
  readonly message: string;
  /** Top-level field NAMES of the raw error (names only, never values). */
  readonly shapeFields?: readonly string[];
  /** Whether any text/thinking/tool output had streamed when the failure hit. */
  readonly outputStarted: boolean;
}

/** One persisted, deduped observation: the input shape plus first/last-seen timestamps and a count. */
export interface ProviderObservation {
  readonly fingerprint: string;
  readonly provider: string;
  readonly model?: string;
  readonly authMode?: string;
  readonly phase: string;
  readonly classification: ProviderFailureClass;
  readonly retryable: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly message: string;
  readonly shapeFields?: readonly string[];
  readonly outputStarted: boolean;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly count: number;
}

/** The JSON file backing the store: `<TREVOR_STATE_HOME>/provider-observations.json`. */
export function observationsPath(): string {
  return join(resolveTrevorStateHome(), "provider-observations.json");
}

/**
 * Collapses a message to a stable skeleton for fingerprinting: redacted, lowercased, with digit runs,
 * IP/host:port, UUIDs, and hex blobs replaced by placeholders, so "ECONNREFUSED 127.0.0.1:1234" and
 * "ECONNREFUSED 10.0.0.2:5678" fingerprint identically (same shape, different transient values).
 */
function messageSkeleton(message: string): string {
  return (
    redactSecrets(message)
      .toLowerCase()
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "«uuid»")
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "«addr»")
      .replace(/\b[0-9a-f]{12,}\b/g, "«hex»")
      // Any word token carrying a digit (request ids, short hex, ports, model suffixes) is a varying
      // value, not stable shape - collapse it so the same failure with different ids fingerprints alike.
      .replace(/\b(?=\w*\d)\w+\b/g, "#")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** The fingerprint-relevant shape of a failure: the stable identity bits, shared by the observation
 *  store and the provider-failure log so a failure fingerprints identically wherever it is recorded. */
export interface FingerprintParts {
  readonly provider: string;
  readonly classification: ProviderFailureClass;
  readonly status?: number;
  readonly code?: string;
  readonly shapeFields?: readonly string[];
  readonly message: string;
}

/** A stable fingerprint for a failure shape: same provider + class + status/code + field set +
 *  message skeleton hash to the same id, so repeats dedupe (and log lines correlate) instead of
 *  piling up. The single source of the fingerprint for every failure surface. */
export function failureFingerprint(parts: FingerprintParts): string {
  const joined = [
    parts.provider,
    parts.classification,
    parts.status ?? "",
    parts.code ?? "",
    [...(parts.shapeFields ?? [])].sort().join(","),
    messageSkeleton(parts.message),
  ].join("|");
  return createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

/** A stable fingerprint for an observation (delegates to {@link failureFingerprint}). */
export function fingerprintObservation(input: ObservationInput): string {
  return failureFingerprint(input);
}

/** Builds a fresh (count 1) observation record from an input at time `nowIso`, message re-redacted. */
export function buildObservation(input: ObservationInput, nowIso: string): ProviderObservation {
  return {
    fingerprint: fingerprintObservation(input),
    provider: input.provider,
    model: input.model,
    authMode: input.authMode,
    phase: input.phase,
    classification: input.classification,
    retryable: input.retryable,
    status: input.status,
    code: input.code,
    message: redactSecrets(input.message),
    shapeFields: input.shapeFields,
    outputStarted: input.outputStarted,
    firstSeen: nowIso,
    lastSeen: nowIso,
    count: 1,
  };
}

/** Folds a fresh sighting into an existing record: bump the count + lastSeen, keep the firstSeen. */
export function mergeObservation(
  existing: ProviderObservation,
  fresh: ProviderObservation,
): ProviderObservation {
  return {
    ...existing,
    // Refresh the mutable shape fields to the latest sighting (message skeleton is identical anyway).
    message: fresh.message,
    lastSeen: fresh.lastSeen,
    count: existing.count + 1,
  };
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
