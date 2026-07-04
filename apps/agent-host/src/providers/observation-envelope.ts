import { randomUUID } from "node:crypto";
import {
  fingerprintObservation,
  hash16,
  type ObservationInput,
  sanitizeFailureDetail,
} from "./failure-record-schema";

/**
 * The common, versioned observation envelope shared by every producer of the local observation corpus
 * (plan 29 M2/M7). Provider failures are the first producer; tool/loop/harness producers are declared
 * here as schema-only kinds (not wired to any runtime path yet). The envelope keeps producer-specific
 * fields under `source`/`shape` payloads so the top-level shape never drifts, and it re-redacts every
 * string field so raw prompts, tool outputs, transcript text, secrets, or payload bodies can never
 * reach disk.
 *
 * Responsible for: the envelope shape, kind vocabulary, per-producer builders, defensive decode, and
 * shape-summary redaction.
 * Not for: filesystem persistence (observation-corpus.ts) or the producer callsites (observation-store.ts).
 */

/** Bumped when the envelope shape changes in a way older readers can't understand. */
export const OBSERVATION_SCHEMA_VERSION = 1;

/** Bumped when the redaction rules change; a record redacted by a newer version is not decoded. */
export const OBSERVATION_REDACTION_VERSION = 1;

/** Every observation-producer class. Only `provider_failure` is wired; the rest are schema-only (M7). */
export const OBSERVATION_KINDS = [
  "provider_failure",
  "tool_pattern",
  "loop_pattern",
  "harness_guidance",
] as const;

export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** Each producer kind appends to its own JSONL log under the corpus dir; the index spans all kinds. */
export const OBSERVATION_KIND_FILES: Record<ObservationKind, string> = {
  provider_failure: "provider-failures.jsonl",
  tool_pattern: "tool-patterns.jsonl",
  loop_pattern: "loop-patterns.jsonl",
  harness_guidance: "harness-guidance.jsonl",
};

/** A single scalar or a list of short shape tokens (field names). No nested objects: shape stays flat. */
export type ObservationField = string | number | boolean | readonly string[];

/** A flat, redacted payload of shape tokens - never raw prompts, bodies, outputs, or transcript text. */
export type ObservationPayload = Readonly<Record<string, ObservationField>>;

/**
 * One deduped observation shape. As a JSONL line it is a delta contribution (usually count 1); folded
 * into the index it is the aggregate (count = total sightings, firstSeen/lastSeen the span). The two
 * uses share one shape so a migrated aggregate and a live sighting fold identically.
 */
export interface ObservationEnvelope {
  readonly schemaVersion: number;
  readonly id: string;
  readonly kind: ObservationKind;
  readonly fingerprint: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly count: number;
  readonly redactionVersion: number;
  readonly source: ObservationPayload;
  readonly shape: ObservationPayload;
}

/** The longest a single shape-summary string may be; anything longer is truncated so no body/transcript lands. */
const MAX_FIELD_LENGTH = 300;

function newObservationId(): string {
  return `obs_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Redacts + length-caps one shape field so no secret or raw body survives into the corpus. */
function sanitizeField(value: ObservationField): ObservationField {
  if (typeof value === "string") {
    const redacted = sanitizeFailureDetail(value);
    return redacted.length > MAX_FIELD_LENGTH
      ? `${redacted.slice(0, MAX_FIELD_LENGTH)}…`
      : redacted;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeFailureDetail(String(entry)).slice(0, MAX_FIELD_LENGTH));
  }
  return value;
}

/** Redacts every string field of a producer payload, dropping undefined values. */
function sanitizePayload(
  payload: Readonly<Record<string, ObservationField | undefined>>,
): ObservationPayload {
  const out: Record<string, ObservationField> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) {
      out[key] = sanitizeField(value);
    }
  }
  return out;
}

/** Assembles a fresh delta envelope (count 1) from an already-fingerprinted producer shape. */
function buildEnvelope(args: {
  readonly kind: ObservationKind;
  readonly fingerprint: string;
  readonly nowIso: string;
  readonly source: Readonly<Record<string, ObservationField | undefined>>;
  readonly shape: Readonly<Record<string, ObservationField | undefined>>;
}): ObservationEnvelope {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: newObservationId(),
    kind: args.kind,
    fingerprint: args.fingerprint,
    firstSeen: args.nowIso,
    lastSeen: args.nowIso,
    count: 1,
    redactionVersion: OBSERVATION_REDACTION_VERSION,
    source: sanitizePayload(args.source),
    shape: sanitizePayload(args.shape),
  };
}

/** Builds a provider_failure delta envelope from the recorded failure input (message re-redacted). */
export function providerFailureEnvelope(
  input: ObservationInput,
  nowIso: string,
): ObservationEnvelope {
  return buildEnvelope({
    kind: "provider_failure",
    fingerprint: fingerprintObservation(input),
    nowIso,
    source: {
      provider: input.provider,
      model: input.model,
      authMode: input.authMode,
      phase: input.phase,
    },
    shape: {
      classification: input.classification,
      retryable: input.retryable,
      status: input.status,
      code: input.code,
      message: input.message,
      fieldNames: input.shapeFields,
      outputStarted: input.outputStarted,
    },
  });
}

/** A stable fingerprint for a later-producer shape: the kind plus its sorted redacted shape tokens. */
function producerFingerprint(kind: ObservationKind, tokens: readonly string[]): string {
  const joined = [kind, ...tokens.map((t) => sanitizeFailureDetail(t))].join("|");
  return hash16(joined);
}

/** M7 (schema only): a tool-pattern shape summary. No raw output/prompt fields - only shape tokens. */
export interface ToolPatternInput {
  readonly tool: string;
  readonly phase: string;
  readonly outcome: string;
  /** An optional short, redacted detail token; anything long is truncated. */
  readonly detail?: string;
  readonly fieldNames?: readonly string[];
}

export function toolPatternEnvelope(input: ToolPatternInput, nowIso: string): ObservationEnvelope {
  return buildEnvelope({
    kind: "tool_pattern",
    fingerprint: producerFingerprint("tool_pattern", [input.tool, input.phase, input.outcome]),
    nowIso,
    source: { tool: input.tool, phase: input.phase },
    shape: { outcome: input.outcome, detail: input.detail, fieldNames: input.fieldNames },
  });
}

/** M7 (schema only): a loop-pattern shape summary. */
export interface LoopPatternInput {
  readonly pattern: string;
  readonly phase: string;
  readonly detail?: string;
}

export function loopPatternEnvelope(input: LoopPatternInput, nowIso: string): ObservationEnvelope {
  return buildEnvelope({
    kind: "loop_pattern",
    fingerprint: producerFingerprint("loop_pattern", [input.pattern, input.phase]),
    nowIso,
    source: { phase: input.phase },
    shape: { pattern: input.pattern, detail: input.detail },
  });
}

/** M7 (schema only): a harness-guidance shape summary. */
export interface HarnessGuidanceInput {
  readonly topic: string;
  readonly outcome: string;
  readonly detail?: string;
}

export function harnessGuidanceEnvelope(
  input: HarnessGuidanceInput,
  nowIso: string,
): ObservationEnvelope {
  return buildEnvelope({
    kind: "harness_guidance",
    fingerprint: producerFingerprint("harness_guidance", [input.topic, input.outcome]),
    nowIso,
    source: { topic: input.topic },
    shape: { outcome: input.outcome, detail: input.detail },
  });
}

/** Folds a delta contribution into an existing aggregate: count sums, first/last span widens. */
export function foldObservationDelta(
  existing: ObservationEnvelope | undefined,
  delta: ObservationEnvelope,
): ObservationEnvelope {
  if (!existing) {
    return delta;
  }
  // Spread the later sighting (its lastSeen is already the max), then restore the stable identity, the
  // earliest firstSeen, and the summed count.
  const latest = delta.lastSeen >= existing.lastSeen ? delta : existing;
  return {
    ...latest,
    id: existing.id,
    fingerprint: existing.fingerprint,
    firstSeen: existing.firstSeen <= delta.firstSeen ? existing.firstSeen : delta.firstSeen,
    count: existing.count + delta.count,
  };
}

function isObservationKind(value: unknown): value is ObservationKind {
  return typeof value === "string" && (OBSERVATION_KINDS as readonly string[]).includes(value);
}

function isPayload(value: unknown): value is ObservationPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (field) =>
      typeof field === "string" ||
      typeof field === "number" ||
      typeof field === "boolean" ||
      (Array.isArray(field) && field.every((entry) => typeof entry === "string")),
  );
}

/**
 * Decodes an already-parsed value into an envelope defensively: any missing/mistyped field, unknown
 * kind, or a redaction version newer than this build understands yields null so a single corrupt
 * record never poisons the whole corpus read.
 */
export function decodeObservationValue(parsed: unknown): ObservationEnvelope | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.schemaVersion !== "number" ||
    typeof record.id !== "string" ||
    !isObservationKind(record.kind) ||
    typeof record.fingerprint !== "string" ||
    typeof record.firstSeen !== "string" ||
    typeof record.lastSeen !== "string" ||
    typeof record.count !== "number" ||
    typeof record.redactionVersion !== "number" ||
    record.redactionVersion > OBSERVATION_REDACTION_VERSION ||
    !isPayload(record.source) ||
    !isPayload(record.shape)
  ) {
    return null;
  }
  return {
    schemaVersion: record.schemaVersion,
    id: record.id,
    kind: record.kind,
    fingerprint: record.fingerprint,
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
    count: record.count,
    redactionVersion: record.redactionVersion,
    source: record.source,
    shape: record.shape,
  };
}

/** Decodes one JSONL line (parse + validate) into an envelope, or null when unparseable/corrupt. */
export function decodeObservationEnvelope(line: string): ObservationEnvelope | null {
  try {
    return decodeObservationValue(JSON.parse(line));
  } catch {
    return null;
  }
}
