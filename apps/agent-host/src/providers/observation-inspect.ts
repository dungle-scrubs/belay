import type { ObservationIndex } from "./observation-corpus";
import type { ObservationEnvelope } from "./observation-envelope";
import { OBSERVATION_SCHEMA_VERSION } from "./observation-envelope";

/**
 * The inspect/export/delete command paths over the observation corpus (plan 29 M5). These are the
 * user-visible control surfaces the corpus needs before it grows: a redacted human report, a redacted
 * export bundle for a debug dump, and the confirm predicate a destructive delete requires.
 *
 * Privacy boundary (D-004): every field here is already redacted at the write boundary
 * (observation-envelope.ts). The ONLY fields that may be inspected or exported are the envelope's
 * shape metadata - schemaVersion, id, kind, fingerprint, firstSeen, lastSeen, count, redactionVersion,
 * and the redacted `source`/`shape` payloads (provider, model, auth MODE, phase, classification, retry
 * decision, status/code, a redacted message skeleton, field NAMES, output-started). Raw prompts,
 * secrets, auth values, response bodies, tool outputs, and transcript text are never present to begin
 * with, so no field here can leak them.
 *
 * Responsible for: formatting an inspect report, building the export bundle, and the delete-confirm
 * predicate.
 * Not for: filesystem read/delete mechanics (observation-corpus.ts).
 */

/** A redacted export bundle: schema version, producer counts, and the deduped records. */
export interface ObservationBundle {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly counts: {
    readonly total: number;
    readonly byKind: Readonly<Record<string, number>>;
  };
  readonly records: readonly ObservationEnvelope[];
}

/** Counts sightings per producer kind (for the doctor/debug producer breakdown). */
export function countByKind(index: ObservationIndex): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const record of Object.values(index)) {
    counts[record.kind] = (counts[record.kind] ?? 0) + record.count;
  }
  return counts;
}

/** Builds the redacted export bundle for a debug dump: schema version, producer counts, records. */
export function buildObservationBundle(index: ObservationIndex, nowIso: string): ObservationBundle {
  const records = Object.values(index).sort((a, b) => b.count - a.count);
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    generatedAt: nowIso,
    counts: {
      total: records.reduce((sum, r) => sum + r.count, 0),
      byKind: countByKind(index),
    },
    records,
  };
}

/** One redacted inspect line: kind, fingerprint, count, and span - no message skeleton by default. */
function inspectLine(record: ObservationEnvelope): string {
  return `${record.kind} ${record.fingerprint} ×${record.count} [${record.firstSeen} .. ${record.lastSeen}]`;
}

/** A redacted, human-readable inspect report of the corpus, busiest shapes first. */
export function formatObservationReport(index: ObservationIndex): string {
  const records = Object.values(index).sort((a, b) => b.count - a.count);
  if (records.length === 0) {
    return "observation corpus: empty";
  }
  const header = `observation corpus: ${records.length} shape${records.length === 1 ? "" : "s"}`;
  return [header, ...records.map(inspectLine)].join("\n");
}

/**
 * Whether a corpus delete is the CONFIRMED execution or the describe-and-prompt step. Deleting is
 * irreversible for the JSONL evidence, so a bare delete only explains the effect; the user re-runs
 * with `confirm` to proceed (mirrors the `/stop` confirm gate).
 */
export function isDeleteConfirmed(args: string): boolean {
  return args.trim().toLowerCase() === "confirm";
}
