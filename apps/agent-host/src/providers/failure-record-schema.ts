import { createHash } from "node:crypto";
import type { Fields } from "@host/transport/log";
import type { ProviderFailureEvidence } from "./errors";
import type { ProviderFailureClass, ProviderUserAction } from "./failure-taxonomy";
import { redactSecrets } from "./failure-taxonomy";

/**
 * Shared redaction-safe provider-failure record schema. It owns the common failure shape used by the
 * durable observation store and the in-memory recent-failure log: message sanitizing, stable message
 * skeletons, fingerprints, and the pure record builders. Persistence and ring management stay in
 * their own modules.
 *
 * Responsible for: the redaction-safe failure record shapes - sanitizing, message skeletons,
 * fingerprints, and the pure record/log-field builders.
 * Not for: persistence (observation-store.ts) or the in-memory ring (provider-failure-log.ts).
 */

/** Redacts a human provider-failure detail defensively before it reaches logs or disk. */
export function sanitizeFailureDetail(detail: string): string {
  return redactSecrets(detail);
}

/**
 * Collapses a message to a stable skeleton for fingerprinting: redacted, lowercased, with digit runs,
 * IP/host:port, UUIDs, and hex blobs replaced by placeholders, so "ECONNREFUSED 127.0.0.1:1234" and
 * "ECONNREFUSED 10.0.0.2:5678" fingerprint identically (same shape, different transient values).
 */
export function failureMessageSkeleton(message: string): string {
  return (
    sanitizeFailureDetail(message)
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

/** The fingerprint-relevant shape of a provider failure. */
export interface FingerprintParts {
  readonly provider: string;
  readonly classification: ProviderFailureClass;
  readonly status?: number;
  readonly code?: string;
  readonly shapeFields?: readonly string[];
  readonly message: string;
}

/** A stable fingerprint for a failure shape, shared by every provider-failure surface. */
export function failureFingerprint(parts: FingerprintParts): string {
  const joined = [
    parts.provider,
    parts.classification,
    parts.status ?? "",
    parts.code ?? "",
    [...(parts.shapeFields ?? [])].sort().join(","),
    failureMessageSkeleton(parts.message),
  ].join("|");
  return createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

/** The inputs needed to record one observation. */
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

/** A stable fingerprint for an observation. */
export function fingerprintObservation(input: ObservationInput): string {
  return failureFingerprint(input);
}

/** Builds a fresh observation record from an input at time `nowIso`, message re-redacted. */
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
    message: sanitizeFailureDetail(input.message),
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

/**
 * The inputs to a structured failure log line (already-redacted detail in, sanitized fields out). The
 * failure's diagnostic surface is the shared {@link ProviderFailureEvidence}, so a callsite spreads
 * `providerFailureEvidence(error)` and adds only where/when this line is about.
 */
export type ProviderFailureLogInput = ProviderFailureEvidence & {
  readonly provider: string;
  readonly model: string;
  readonly phase: string;
  /** The reconnect attempt this line is about (0 = the initial attempt / a terminal with no retries). */
  readonly attempt: number;
  /** Whether this line is a between-retries reconnect or the terminal outcome. */
  readonly outcome: "reconnect" | "terminal";
};

/** Builds the flat, greppable fields for a provider-failure log line. */
export function buildProviderFailureLogFields(input: ProviderFailureLogInput): Fields {
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
    detail: sanitizeFailureDetail(input.detail),
  };
}

/** One recorded terminal provider failure (the recent-failures ring; counts/fingerprints only). */
export interface ProviderFailureRecord {
  readonly provider: string;
  readonly model: string;
  readonly classification?: ProviderFailureClass;
  readonly userAction?: ProviderUserAction;
  /** True when the loop exhausted its bounded reconnect budget (a transient outage that gave up);
   *  false when the failure was a non-retryable terminal one (auth, quota, rejected, etc.). */
  readonly retryExhausted: boolean;
  /** How many reconnect attempts were made before going terminal (0 when never retryable). */
  readonly attempts: number;
  readonly fingerprint: string;
  /** A sanitized one-line detail (re-redacted on record). */
  readonly detail: string;
  readonly at: string;
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

/** Builds one sanitized recent-failure record from a terminal provider failure input. */
export function buildProviderFailureRecord(input: RecordFailureInput): ProviderFailureRecord {
  return {
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
    detail: sanitizeFailureDetail(input.detail),
    at: input.at,
  };
}
